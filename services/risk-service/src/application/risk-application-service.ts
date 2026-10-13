import {
  MARKET_CATALOG,
  addAmounts,
  evaluateApiWriteGate,
  alignsToStep,
  compareAmounts,
  divideAmounts,
  isPositiveAmount,
  isStopOrderType,
  isStpMode,
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

    if (!["limit", "market", "stop_limit", "stop_market"].includes(command.type)) {
      throw new RiskServiceError("UNSUPPORTED_ORDER_TYPE", 400, `Unsupported order type ${command.type}`);
    }
    const isStop = isStopOrderType(command.type);
    // Limit-priced orders: limit and stop_limit; market-priced: market and stop_market.
    const isLimitPriced = command.type === "limit" || command.type === "stop_limit";
    const postOnly = command.postOnly === true || (command.postOnly as unknown) === "true";

    const timeInForce = !isLimitPriced
      ? (command.timeInForce ?? "ioc")
      : (command.timeInForce ?? "gtc");
    if (!["gtc", "ioc", "fok"].includes(timeInForce)) {
      throw new RiskServiceError(
        "UNSUPPORTED_TIME_IN_FORCE",
        400,
        `Unsupported time in force ${timeInForce}`
      );
    }

    if (!isLimitPriced && timeInForce === "gtc") {
      throw new RiskServiceError(
        "UNSUPPORTED_TIME_IN_FORCE",
        400,
        "Market orders do not support GTC"
      );
    }

    if (isLimitPriced && !command.price) {
      throw new RiskServiceError("PRICE_REQUIRED", 400, "Limit order price is required");
    }

    if (postOnly && (command.type !== "limit" || timeInForce !== "gtc")) {
      throw new RiskServiceError(
        "POST_ONLY_REQUIRES_GTC_LIMIT",
        400,
        "Post-only is only supported for GTC limit orders"
      );
    }

    if (command.stpMode !== undefined && !isStpMode(command.stpMode)) {
      throw new RiskServiceError(
        "INVALID_STP_MODE",
        400,
        `Unsupported stpMode ${String(command.stpMode)} (expire_taker | expire_maker | expire_both)`
      );
    }

    if (isStop && !command.triggerPrice) {
      throw new RiskServiceError("TRIGGER_PRICE_REQUIRED", 400, "Stop orders require triggerPrice");
    }
    if (!isStop && command.triggerPrice) {
      throw new RiskServiceError(
        "TRIGGER_PRICE_NOT_ALLOWED",
        400,
        "triggerPrice is only valid for stop_limit / stop_market orders"
      );
    }
    if (isStop && command.triggerPrice && !isPositiveAmount(command.triggerPrice)) {
      throw new RiskServiceError(
        "INVALID_TRIGGER_PRICE",
        400,
        "Trigger price must be greater than zero"
      );
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
    if (isLimitPriced && command.price) {
      this.assertStepAlignment("price_precision", command.price, market.priceStep, checks);
    }
    if (isStop && command.triggerPrice) {
      this.assertStepAlignment("trigger_price_precision", command.triggerPrice, market.priceStep, checks);
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
    if (isStop && command.triggerPrice && reference) {
      // The trigger must sit within the same band as a limit price, so a stop
      // cannot be parked at an absurd level.
      const deviation = this.calculateDeviationRatio(command.triggerPrice, reference.price);
      if (compareAmounts(deviation, market.maxPriceDeviationRatio) > 0) {
        throw new RiskServiceError(
          "TRIGGER_PRICE_DEVIATION_TOO_HIGH",
          400,
          `Trigger price deviation ${deviation} exceeds limit ${market.maxPriceDeviationRatio} (reference ${reference.price} from ${reference.source})`
        );
      }
      checks.push({
        name: "trigger_price_deviation",
        status: "passed",
        detail: `trigger ${command.triggerPrice} within ${market.maxPriceDeviationRatio} of reference ${reference.price} (${reference.source})`
      });
    }

    if (command.type === "stop_limit" && command.price && command.triggerPrice) {
      // A stop-limit executes around its trigger, so its limit price is
      // bounded against the trigger rather than today's price.
      const deviation = this.calculateDeviationRatio(command.price, command.triggerPrice);
      if (compareAmounts(deviation, market.maxPriceDeviationRatio) > 0) {
        throw new RiskServiceError(
          "PRICE_DEVIATION_TOO_HIGH",
          400,
          `Stop-limit price deviation ${deviation} from trigger ${command.triggerPrice} exceeds limit ${market.maxPriceDeviationRatio}`
        );
      }
      checks.push({
        name: "price_deviation",
        status: "passed",
        detail: `stop-limit price within ${market.maxPriceDeviationRatio} of trigger ${command.triggerPrice}`
      });
    }

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
      ...(isStop ? { triggerPrice: command.triggerPrice } : {}),
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

    if (command.type === "limit" || command.type === "stop_limit") {
      return multiplyAmounts(command.price ?? "0", command.quantity);
    }

    // stop_market buys execute once the price reached the trigger, so the
    // cap is computed from the trigger price instead of today's price.
    const priceForLock = command.type === "stop_market" ? command.triggerPrice : referencePrice;
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
