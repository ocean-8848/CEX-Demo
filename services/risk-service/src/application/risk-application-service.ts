import {
  MARKET_CATALOG,
  addAmounts,
  evaluateApiWriteGate,
  alignsToStep,
  compareAmounts,
  divideAmounts,
  isPositiveAmount,
  multiplyAmounts,
  referencePriceEnvKey,
  subtractAmounts,
  type MarketCatalog,
  type SpotMarket
} from "@web3-cex/domain";

import type { ControlSwitchService } from "./control-switch-service.js";
import { MarketStatusService } from "./market-status-service.js";
import { RiskServiceError } from "../domain/errors.js";
import type { RiskLedgerClient } from "../domain/ledger-client.js";
import type { ReferencePrice, ReferencePriceProvider } from "../domain/reference-price.js";
import type {
  RiskCheckResult,
  SpotOrderRiskDecision,
  ValidateSpotOrderRiskCommand
} from "../domain/types.js";

interface ServiceOptions {
  /** Configured fallback prices, used when no live market price exists. */
  referencePrices?: Partial<Record<SpotMarket, string>>;
  /** Live price source (market-data-service). */
  referencePriceProvider?: ReferencePriceProvider;
  /** Market rules; defaults to config/markets.json. */
  catalog?: MarketCatalog;
  /** Effective market status (config default + ops overrides). */
  marketStatus?: MarketStatusService;
  /** Emergency switches; when set, an API write freeze rejects new orders. */
  controlSwitches?: Pick<ControlSwitchService, "getState">;
  env?: Record<string, string | undefined>;
}

/**
 * Configured reference price per market: `RISK_REFERENCE_PRICE_<BASE>_<QUOTE>`
 * env override first, then `referencePrice` from config/markets.json.
 */
export function buildConfiguredReferencePrices(
  catalog: MarketCatalog = MARKET_CATALOG,
  env: Record<string, string | undefined> = process.env
): Record<SpotMarket, string> {
  return Object.fromEntries(
    catalog
      .listMarketDefinitions({ includeDelisted: true })
      .map((definition) => [
        definition.market,
        env[referencePriceEnvKey(definition.market)]?.trim() || definition.referencePrice
      ])
  );
}

export class RiskApplicationService {
  private readonly referencePrices: Record<SpotMarket, string>;
  private readonly referencePriceProvider?: ReferencePriceProvider;
  private readonly catalog: MarketCatalog;
  readonly marketStatus: MarketStatusService;
  private readonly controlSwitches?: Pick<ControlSwitchService, "getState">;

  constructor(
    private readonly ledgerClient: RiskLedgerClient,
    options: ServiceOptions = {}
  ) {
    this.catalog = options.catalog ?? MARKET_CATALOG;
    const overrides = Object.entries(options.referencePrices ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    );
    this.referencePrices = {
      ...buildConfiguredReferencePrices(this.catalog, options.env),
      ...Object.fromEntries(overrides)
    };
    this.referencePriceProvider = options.referencePriceProvider;
    this.marketStatus = options.marketStatus ?? new MarketStatusService({ catalog: this.catalog });
    this.controlSwitches = options.controlSwitches;
  }

  /** Request override > last trade > book mid > configured value. */
  async resolveReferencePrice(market: SpotMarket, requested?: string): Promise<ReferencePrice | null> {
    if (requested && isPositiveAmount(requested)) {
      return { price: requested, source: "request" };
    }
    const live = await this.referencePriceProvider?.getReferencePrice(market);
    if (live) {
      return live;
    }
    const configured = this.referencePrices[market];
    return configured && isPositiveAmount(configured) ? { price: configured, source: "configured" } : null;
  }

  async validateSpotOrder(command: ValidateSpotOrderRiskCommand): Promise<SpotOrderRiskDecision> {
    const market = this.catalog.getMarket(command.market);
    if (!market) {
      throw new RiskServiceError(
        "UNSUPPORTED_MARKET",
        400,
        `Market ${command.market} is not supported`
      );
    }

    // API write freeze (read-only mode): order-service always validates here
    // before freezing funds, so this is the defence-in-depth check behind the
    // api-gateway guard. Cancels never pass through risk.
    if (this.controlSwitches) {
      const frozen = evaluateApiWriteGate(await this.controlSwitches.getState());
      if (frozen) {
        throw new RiskServiceError(frozen.code, 409, frozen.message);
      }
    }

    // Halted / delisted markets reject new orders. Cancels never pass through
    // risk, so users can always pull resting orders out of a halted book.
    const { status, override } = await this.marketStatus.getEffectiveStatus(command.market);
    if (status === "halted") {
      throw new RiskServiceError(
        "MARKET_HALTED",
        409,
        `Market ${command.market} is halted${override?.reason ? `: ${override.reason}` : ""}; new orders are rejected, cancels are still allowed`
      );
    }
    if (status === "delisted") {
      throw new RiskServiceError(
        "MARKET_DELISTED",
        409,
        `Market ${command.market} is delisted; new orders are rejected`
      );
    }

    const timeInForce =
      command.type === "market" ? (command.timeInForce ?? "ioc") : (command.timeInForce ?? "gtc");
    if (!["gtc", "ioc", "fok"].includes(timeInForce)) {
      throw new RiskServiceError(
        "UNSUPPORTED_TIME_IN_FORCE",
        400,
        `Unsupported time in force ${timeInForce}`
      );
    }

    if (command.type === "market" && timeInForce === "gtc") {
      throw new RiskServiceError(
        "UNSUPPORTED_TIME_IN_FORCE",
        400,
        "Market orders do not support GTC"
      );
    }

    if (command.type === "limit" && !command.price) {
      throw new RiskServiceError("PRICE_REQUIRED", 400, "Limit order price is required");
    }

    if (!isPositiveAmount(command.quantity)) {
      throw new RiskServiceError(
        "INVALID_ORDER_QUANTITY",
        400,
        "Order quantity must be greater than zero"
      );
    }

    if (command.price && !isPositiveAmount(command.price)) {
      throw new RiskServiceError(
        "INVALID_ORDER_PRICE",
        400,
        "Order price must be greater than zero"
      );
    }

    const checks: RiskCheckResult[] = [];
    this.assertStepAlignment("quantity_precision", command.quantity, market.quantityStep, checks);
    if (command.type === "limit" && command.price) {
      this.assertStepAlignment("price_precision", command.price, market.priceStep, checks);
    }

    if (compareAmounts(command.quantity, market.minQuantity) < 0) {
      throw new RiskServiceError(
        "ORDER_MIN_QUANTITY_NOT_MET",
        400,
        `Order quantity ${command.quantity} is below minimum ${market.minQuantity}`
      );
    }
    checks.push({
      name: "minimum_quantity",
      status: "passed",
      detail: `quantity ${command.quantity} >= ${market.minQuantity}`
    });

    const reference = await this.resolveReferencePrice(command.market, command.referencePrice);
    const referencePrice = reference?.price;
    if (command.type === "limit" && command.price && reference) {
      const deviation = this.calculateDeviationRatio(command.price, reference.price);
      if (compareAmounts(deviation, market.maxPriceDeviationRatio) > 0) {
        throw new RiskServiceError(
          "PRICE_DEVIATION_TOO_HIGH",
          400,
          `Order price deviation ${deviation} exceeds limit ${market.maxPriceDeviationRatio} (reference ${reference.price} from ${reference.source})`
        );
      }
      checks.push({
        name: "price_deviation",
        status: "passed",
        detail: `deviation ${deviation} within ${market.maxPriceDeviationRatio} of reference ${reference.price} (${reference.source})`
      });
    }

    const lockAssetCode = command.side === "buy" ? market.quoteAsset : market.baseAsset;
    const lockAmount = this.resolveLockAmount(command, market.maxPriceDeviationRatio, referencePrice);
    const balance = await this.ledgerClient.getBalance(command.accountId, lockAssetCode);

    if (compareAmounts(balance.available, lockAmount) < 0) {
      throw new RiskServiceError(
        "INSUFFICIENT_AVAILABLE_BALANCE",
        400,
        `Available ${lockAssetCode} balance ${balance.available} is below required ${lockAmount}`
      );
    }
    checks.push({
      name: "available_balance",
      status: "passed",
      detail: `${lockAssetCode} available ${balance.available} >= ${lockAmount}`
    });

    return {
      valid: true,
      market: command.market,
      side: command.side,
      type: command.type,
      timeInForce,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      lockAssetCode,
      lockAmount,
      feeRate: market.takerFeeRate,
      referencePrice: reference?.price,
      referencePriceSource: reference?.source,
      checks
    };
  }

  private assertStepAlignment(
    name: string,
    value: string,
    step: string,
    checks: RiskCheckResult[]
  ): void {
    if (!alignsToStep(value, step)) {
      throw new RiskServiceError(
        "INVALID_STEP_ALIGNMENT",
        400,
        `${name} ${value} does not align to step ${step}`
      );
    }

    checks.push({
      name,
      status: "passed",
      detail: `${value} aligns to step ${step}`
    });
  }

  private calculateDeviationRatio(price: string, referencePrice: string): string {
    const difference =
      compareAmounts(price, referencePrice) >= 0
        ? subtractAmounts(price, referencePrice)
        : subtractAmounts(referencePrice, price);

    return divideAmounts(difference, referencePrice);
  }

  private resolveLockAmount(
    command: ValidateSpotOrderRiskCommand,
    maxPriceDeviationRatio: string,
    referencePrice?: string
  ): string {
    if (command.side === "sell") {
      return command.quantity;
    }

    if (command.type === "limit") {
      return multiplyAmounts(command.price ?? "0", command.quantity);
    }

    const priceForLock = referencePrice;
    if (!priceForLock || !isPositiveAmount(priceForLock)) {
      throw new RiskServiceError(
        "REFERENCE_PRICE_REQUIRED",
        400,
        "Market buy orders require a positive reference price"
      );
    }

    const capMultiplier = addAmounts("1", maxPriceDeviationRatio);
    return multiplyAmounts(multiplyAmounts(priceForLock, command.quantity), capMultiplier);
  }
}
