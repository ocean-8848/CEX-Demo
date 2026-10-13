import { addAmounts, multiplyAmounts } from "@web3-cex/domain";

import type {
  FeeTierOverride,
  FeeTierOverrideAuditEntry,
  FeeTierRepository
} from "../domain/fee-tier-repository.js";
import type { SpotTradeRecord } from "../domain/types.js";

/**
 * Memory-mode / test repository. Volume is computed from whatever trade source
 * the caller provides (normally the in-memory order repository).
 */
export class InMemoryFeeTierRepository implements FeeTierRepository {
  private readonly overrides = new Map<string, FeeTierOverride>();
  private readonly audit: FeeTierOverrideAuditEntry[] = [];

  constructor(private readonly listTrades: () => Promise<SpotTradeRecord[]> = async () => []) {}

  async sumUserVolume(userId: string, since: string, markets: string[]): Promise<string> {
    const sinceTime = Date.parse(since);
    let volume = "0";
    for (const trade of await this.listTrades()) {
      if (
        (trade.buyerUserId === userId || trade.sellerUserId === userId) &&
        Date.parse(trade.executedAt) >= sinceTime &&
        markets.includes(trade.market)
      ) {
        volume = addAmounts(volume, multiplyAmounts(trade.price, trade.quantity));
      }
    }
    return volume;
  }

  async findOverride(userId: string): Promise<FeeTierOverride | null> {
    return this.overrides.get(userId) ?? null;
  }

  async listOverrides(): Promise<FeeTierOverride[]> {
    return [...this.overrides.values()];
  }

  async saveOverride(override: FeeTierOverride): Promise<void> {
    const existing = this.overrides.get(override.userId);
    this.overrides.set(override.userId, { ...override, createdAt: existing?.createdAt ?? override.createdAt });
  }

  async deleteOverride(userId: string): Promise<void> {
    this.overrides.delete(userId);
  }

  async appendAudit(entry: FeeTierOverrideAuditEntry): Promise<void> {
    this.audit.unshift(entry);
  }

  async listAudit(query: { userId?: string; limit: number }): Promise<FeeTierOverrideAuditEntry[]> {
    return this.audit.filter((entry) => !query.userId || entry.userId === query.userId).slice(0, query.limit);
  }
}
