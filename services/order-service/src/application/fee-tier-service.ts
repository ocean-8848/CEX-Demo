import { randomUUID } from "node:crypto";

import {
  FEE_TIER_CONFIG,
  describeFeeTierProgress,
  effectiveFeeRate,
  findFeeTier,
  findMarketMaker,
  listSpotMarketDefinitions,
  resolveFeeTier,
  type FeeTierConfig,
  type FeeTierDefinition
} from "@web3-cex/domain";

import { OrderServiceError } from "../domain/errors.js";
import type {
  FeeTierOverride,
  FeeTierOverrideAuditEntry,
  FeeTierRepository,
  FeeTierResolver,
  UserFeeTier
} from "../domain/fee-tier-repository.js";

interface FeeTierServiceOptions {
  config?: FeeTierConfig;
  now?: () => Date;
  createId?: () => string;
  /** How long a resolved tier is reused for new fills (ms). 0 disables caching. */
  cacheMs?: number;
}

export interface UserFeeTierProfile extends UserFeeTier {
  volumeAsset: string;
  volumeWindowDays: number;
  nextTier: FeeTierDefinition | null;
  remainingVolume: string;
  progressRatio: number;
  override: FeeTierOverride | null;
  marketMaker: { label: string; feeTier?: string } | null;
  /** Effective per-market rates: min(tier rate, market rate). */
  markets: Array<{ market: string; makerFeeRate: string; takerFeeRate: string }>;
  tiers: FeeTierDefinition[];
}

/**
 * Resolves each account's VIP tier from its trailing spot volume.
 *
 * Determinism: the tier is resolved when a fill is built and the resulting
 * rate + tier are written onto the trade, so settlement and any replay use the
 * recorded rate, never a re-resolution. The short cache only trades freshness
 * of the volume figure (a tier change takes effect within `cacheMs`) for not
 * running a SUM per fill; override changes invalidate it immediately.
 */
export class FeeTierService implements FeeTierResolver {
  private readonly config: FeeTierConfig;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly cacheMs: number;
  private readonly cache = new Map<string, { value: UserFeeTier; expiresAt: number }>();
  private readonly volumeMarkets: string[];

  constructor(
    private readonly repository: FeeTierRepository,
    options: FeeTierServiceOptions = {}
  ) {
    this.config = options.config ?? FEE_TIER_CONFIG;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
    this.cacheMs = Math.max(options.cacheMs ?? 30_000, 0);
    // Delisted markets included: their past trades still count.
    this.volumeMarkets = listSpotMarketDefinitions({ includeDelisted: true })
      .filter((market) => market.quoteAsset === this.config.volumeAsset)
      .map((market) => market.market);
  }

  getConfig() {
    return {
      volumeAsset: this.config.volumeAsset,
      volumeWindowDays: this.config.volumeWindowDays,
      volumeMarkets: this.volumeMarkets,
      tiers: this.config.tiers,
      marketMakers: this.config.marketMakers
    };
  }

  async resolve(userId: string, options: { fresh?: boolean } = {}): Promise<UserFeeTier> {
    const nowMs = this.now().getTime();
    const cached = this.cache.get(userId);
    if (!options.fresh && cached && cached.expiresAt > nowMs) {
      return cached.value;
    }
    const since = new Date(nowMs - this.config.volumeWindowDays * 86_400_000).toISOString();
    // Programme members with a pinned tier skip the volume SUM on the fill
    // path (market makers trade all day); the profile view still shows it.
    const pinned = !options.fresh && Boolean(findMarketMaker(this.config, userId)?.feeTier);
    const [volume, override] = await Promise.all([
      pinned ? Promise.resolve("0") : this.repository.sumUserVolume(userId, since, this.volumeMarkets),
      this.repository.findOverride(userId)
    ]);
    const resolved = resolveFeeTier(this.config, { userId, volume, overrideTier: override?.tier });
    const value: UserFeeTier = { userId, ...resolved, volume, resolvedAt: new Date(nowMs).toISOString() };
    if (this.cacheMs > 0) {
      this.cache.set(userId, { value, expiresAt: nowMs + this.cacheMs });
    }
    return value;
  }

  async resolveMany(userIds: string[]): Promise<Map<string, UserFeeTier>> {
    const unique = [...new Set(userIds.filter((userId) => userId))];
    const resolved = await Promise.all(unique.map((userId) => this.resolve(userId)));
    return new Map(resolved.map((tier) => [tier.userId, tier]));
  }

  async getProfile(userId: string): Promise<UserFeeTierProfile> {
    const tier = await this.resolve(userId, { fresh: true });
    const override = await this.repository.findOverride(userId);
    const progress = describeFeeTierProgress(this.config, tier.volume, tier.tier);
    const marketMaker = findMarketMaker(this.config, userId);
    return {
      ...tier,
      volumeAsset: this.config.volumeAsset,
      volumeWindowDays: this.config.volumeWindowDays,
      nextTier: progress.next ?? null,
      remainingVolume: progress.remainingVolume,
      progressRatio: progress.progressRatio,
      override,
      marketMaker: marketMaker ? { label: marketMaker.label, feeTier: marketMaker.feeTier } : null,
      markets: listSpotMarketDefinitions().map((market) => ({
        market: market.market,
        makerFeeRate: effectiveFeeRate(tier, market, "maker"),
        takerFeeRate: effectiveFeeRate(tier, market, "taker")
      })),
      tiers: this.config.tiers
    };
  }

  async setOverride(command: { userId: string; tier: string; note?: string; actor?: string }): Promise<UserFeeTierProfile> {
    const userId = requireText(command.userId, "userId");
    const note = requireText(command.note, "note");
    const actor = requireText(command.actor, "actor");
    if (!findFeeTier(this.config, command.tier)) {
      throw new OrderServiceError(
        "FEE_TIER_UNKNOWN",
        400,
        `Fee tier ${String(command.tier)} is not configured (${this.config.tiers.map((tier) => tier.tier).join(", ")})`
      );
    }
    const now = this.now().toISOString();
    const previous = await this.repository.findOverride(userId);
    await this.repository.saveOverride({
      userId,
      tier: command.tier,
      note,
      assignedBy: actor,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    });
    await this.repository.appendAudit({
      auditId: this.createId(),
      userId,
      action: "set",
      previousTier: previous?.tier,
      tier: command.tier,
      note,
      actor,
      createdAt: now
    });
    this.cache.delete(userId);
    return this.getProfile(userId);
  }

  async clearOverride(command: { userId: string; note?: string; actor?: string }): Promise<UserFeeTierProfile> {
    const userId = requireText(command.userId, "userId");
    const note = requireText(command.note, "note");
    const actor = requireText(command.actor, "actor");
    const previous = await this.repository.findOverride(userId);
    if (previous) {
      await this.repository.deleteOverride(userId);
      await this.repository.appendAudit({
        auditId: this.createId(),
        userId,
        action: "clear",
        previousTier: previous.tier,
        note,
        actor,
        createdAt: this.now().toISOString()
      });
    }
    this.cache.delete(userId);
    return this.getProfile(userId);
  }

  async listAudit(query: { userId?: string; limit?: number }): Promise<FeeTierOverrideAuditEntry[]> {
    return this.repository.listAudit({ userId: query.userId, limit: Math.min(Math.max(query.limit ?? 50, 1), 200) });
  }

  async listOverrides(): Promise<FeeTierOverride[]> {
    return this.repository.listOverrides();
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OrderServiceError("FEE_TIER_FIELD_REQUIRED", 400, `${field} is required`);
  }
  return value.trim();
}
