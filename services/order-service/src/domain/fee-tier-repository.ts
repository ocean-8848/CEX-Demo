import type { FeeTierSource } from "@web3-cex/domain";

/** Ops-assigned tier (e.g. market-maker programme). */
export interface FeeTierOverride {
  userId: string;
  tier: string;
  note: string;
  assignedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeeTierOverrideAuditEntry {
  auditId: string;
  userId: string;
  action: "set" | "clear";
  previousTier?: string;
  tier?: string;
  note: string;
  actor: string;
  createdAt: string;
}

export interface FeeTierRepository {
  /**
   * Quote-asset notional (price * quantity) the user traded on either side
   * since `since`, over trades of `markets` only (the markets quoted in the
   * tier volume asset). A self-trade counts once.
   */
  sumUserVolume(userId: string, since: string, markets: string[]): Promise<string>;
  findOverride(userId: string): Promise<FeeTierOverride | null>;
  saveOverride(override: FeeTierOverride): Promise<void>;
  deleteOverride(userId: string): Promise<void>;
  appendAudit(entry: FeeTierOverrideAuditEntry): Promise<void>;
  listAudit(query: { userId?: string; limit: number }): Promise<FeeTierOverrideAuditEntry[]>;
  listOverrides(): Promise<FeeTierOverride[]>;
}

/** What order-service resolves for one user at trade time. */
export interface UserFeeTier {
  userId: string;
  tier: string;
  name: string;
  source: FeeTierSource;
  makerFeeRate: string;
  takerFeeRate: string;
  /** Trailing volume (in the config volume asset) the tier was resolved from. */
  volume: string;
  resolvedAt: string;
}

/** Resolves user tiers for `OrderApplicationService.buildTrade`. */
export interface FeeTierResolver {
  resolveMany(userIds: string[]): Promise<Map<string, UserFeeTier>>;
}
