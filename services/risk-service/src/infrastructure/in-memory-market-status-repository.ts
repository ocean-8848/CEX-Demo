import type { SpotMarket } from "@web3-cex/domain";

import type { MarketStatusOverride, MarketStatusRepository } from "../domain/market-status.js";

export class InMemoryMarketStatusRepository implements MarketStatusRepository {
  private readonly overrides = new Map<SpotMarket, MarketStatusOverride>();

  async list(): Promise<MarketStatusOverride[]> {
    return [...this.overrides.values()].map((override) => ({ ...override }));
  }

  async upsert(override: MarketStatusOverride): Promise<MarketStatusOverride> {
    this.overrides.set(override.market, { ...override });
    return { ...override };
  }

  async remove(market: SpotMarket): Promise<void> {
    this.overrides.delete(market);
  }
}
