import {
  MARKET_CATALOG,
  type MarketCatalog,
  type MarketStatus,
  type SpotMarket
} from "@web3-cex/domain";

import { RiskServiceError } from "../domain/errors.js";
import type {
  MarketStatusOverride,
  MarketStatusRepository,
  MarketStatusView,
  SetMarketStatusCommand
} from "../domain/market-status.js";
import { InMemoryMarketStatusRepository } from "../infrastructure/in-memory-market-status-repository.js";

interface MarketStatusServiceOptions {
  /** Markets catalog; defaults to config/markets.json. */
  catalog?: MarketCatalog;
  repository?: MarketStatusRepository;
  /** How long overrides are cached between DB reads (writes through this instance invalidate it). */
  cacheMs?: number;
  now?: () => Date;
}

/**
 * Effective market status = config/markets.json default, unless ops set a
 * runtime override (halt / resume). `delisted` can only come from the file.
 */
export class MarketStatusService {
  private readonly catalog: MarketCatalog;
  private readonly repository: MarketStatusRepository;
  private readonly cacheMs: number;
  private readonly now: () => Date;
  private cache: { overrides: Map<SpotMarket, MarketStatusOverride>; expiresAt: number } | null = null;

  constructor(options: MarketStatusServiceOptions = {}) {
    this.catalog = options.catalog ?? MARKET_CATALOG;
    this.repository = options.repository ?? new InMemoryMarketStatusRepository();
    this.cacheMs = Math.max(options.cacheMs ?? 1000, 0);
    this.now = options.now ?? (() => new Date());
  }

  async getEffectiveStatus(market: SpotMarket): Promise<{ status: MarketStatus; override: MarketStatusOverride | null }> {
    const definition = this.catalog.getMarket(market);
    if (!definition) {
      throw unsupportedMarket(market);
    }
    if (definition.status === "delisted") {
      return { status: "delisted", override: null };
    }
    const override = (await this.loadOverrides()).get(market) ?? null;
    return { status: override?.status ?? definition.status, override };
  }

  async listMarkets(): Promise<MarketStatusView[]> {
    const overrides = await this.loadOverrides();
    return this.catalog.listMarketDefinitions({ includeDelisted: true }).map((definition) => {
      const override = definition.status === "delisted" ? null : (overrides.get(definition.market) ?? null);
      return {
        market: definition.market,
        baseAsset: definition.baseAsset,
        quoteAsset: definition.quoteAsset,
        configuredStatus: definition.status,
        status: override?.status ?? definition.status,
        override,
        priceStep: definition.priceStep,
        quantityStep: definition.quantityStep,
        minQuantity: definition.minQuantity,
        makerFeeRate: definition.makerFeeRate,
        takerFeeRate: definition.takerFeeRate,
        maxPriceDeviationRatio: definition.maxPriceDeviationRatio,
        referencePrice: definition.referencePrice
      };
    });
  }

  async getMarket(market: SpotMarket): Promise<MarketStatusView> {
    const view = (await this.listMarkets()).find((item) => item.market === market);
    if (!view) {
      throw unsupportedMarket(market);
    }
    return view;
  }

  /**
   * Halt or resume a market. Setting the status the file already declares
   * removes the override, so "resume" really means "back to the default".
   */
  async setStatus(command: SetMarketStatusCommand): Promise<MarketStatusView> {
    const definition = this.catalog.getMarket(command.market);
    if (!definition) {
      throw unsupportedMarket(command.market);
    }
    if (command.status !== "listed" && command.status !== "halted") {
      throw new RiskServiceError(
        "INVALID_MARKET_STATUS",
        400,
        `Market status must be listed or halted (delisting is done in config/markets.json)`
      );
    }
    if (definition.status === "delisted") {
      throw new RiskServiceError(
        "MARKET_DELISTED",
        409,
        `Market ${command.market} is delisted in config/markets.json and cannot be changed at runtime`
      );
    }
    const reason = command.reason?.trim() ? command.reason.trim().slice(0, 500) : null;
    if (command.status === "halted" && !reason) {
      throw new RiskServiceError("MARKET_STATUS_REASON_REQUIRED", 400, "A reason is required to halt a market");
    }

    if (command.status === definition.status) {
      await this.repository.remove(command.market);
    } else {
      await this.repository.upsert({
        market: command.market,
        status: command.status,
        reason,
        updatedBy: command.operator?.trim() || "unknown",
        updatedAt: this.now().toISOString()
      });
    }
    this.cache = null;
    return this.getMarket(command.market);
  }

  private async loadOverrides(): Promise<Map<SpotMarket, MarketStatusOverride>> {
    const nowMs = Date.now();
    if (this.cache && this.cache.expiresAt > nowMs) {
      return this.cache.overrides;
    }
    const overrides = new Map(
      (await this.repository.list())
        .filter((override) => this.catalog.isMarket(override.market))
        .map((override) => [override.market, override] as const)
    );
    this.cache = { overrides, expiresAt: nowMs + this.cacheMs };
    return overrides;
  }
}

function unsupportedMarket(market: string): RiskServiceError {
  return new RiskServiceError("UNSUPPORTED_MARKET", 400, `Market ${market} is not supported`);
}
