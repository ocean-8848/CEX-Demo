import {
  CONTROL_SWITCH_SCOPES,
  MARKET_CATALOG,
  buildControlSwitchState,
  controlSwitchKey,
  type ControlSwitchEntry,
  type ControlSwitchState,
  type MarketCatalog
} from "@web3-cex/domain";

import { RiskServiceError } from "../domain/errors.js";
import type {
  ControlSwitchEvent,
  ControlSwitchRepository,
  SetControlSwitchCommand,
  SetControlSwitchResult
} from "../domain/control-switches.js";
import { InMemoryControlSwitchRepository } from "../infrastructure/in-memory-control-switch-repository.js";

interface ControlSwitchServiceOptions {
  catalog?: MarketCatalog;
  repository?: ControlSwitchRepository;
  /** How long the active switches are cached between DB reads (writes invalidate it). */
  cacheMs?: number;
  now?: () => Date;
}

/**
 * Emergency switches owned by risk-service: global withdrawal pause, per-asset
 * withdrawal pause and API write freeze. Consumers (wallet-service,
 * api-gateway, risk's own order validation) read `getState()`.
 *
 * Rules:
 * - turning a switch ON needs a reason;
 * - an `automatic` request (reconciliation breaker) never overrides a switch
 *   that is already ON, and never turns one OFF — resuming is a human decision;
 * - turning OFF a switch that is not ON is a no-op (no event written).
 */
export class ControlSwitchService {
  private readonly catalog: MarketCatalog;
  private readonly repository: ControlSwitchRepository;
  private readonly cacheMs: number;
  private readonly now: () => Date;
  private cache: { entries: ControlSwitchEntry[]; expiresAt: number } | null = null;

  constructor(options: ControlSwitchServiceOptions = {}) {
    this.catalog = options.catalog ?? MARKET_CATALOG;
    this.repository = options.repository ?? new InMemoryControlSwitchRepository();
    this.cacheMs = Math.max(options.cacheMs ?? 1000, 0);
    this.now = options.now ?? (() => new Date());
  }

  async getState(): Promise<ControlSwitchState> {
    return buildControlSwitchState(await this.loadActive(), this.now().toISOString());
  }

  async listEvents(limit = 50): Promise<ControlSwitchEvent[]> {
    const normalized = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50;
    return this.repository.listEvents(normalized);
  }

  async setSwitch(command: SetControlSwitchCommand): Promise<SetControlSwitchResult & { state: ControlSwitchState }> {
    if (!CONTROL_SWITCH_SCOPES.includes(command.scope)) {
      throw new RiskServiceError(
        "INVALID_CONTROL_SWITCH",
        400,
        `scope must be one of ${CONTROL_SWITCH_SCOPES.join(", ")}`
      );
    }
    if (typeof command.enabled !== "boolean") {
      throw new RiskServiceError("INVALID_CONTROL_SWITCH", 400, "enabled must be true or false");
    }
    let assetCode: string | undefined;
    if (command.scope === "withdrawals_asset") {
      assetCode = command.assetCode?.trim().toUpperCase();
      if (!assetCode || !this.catalog.isAsset(assetCode)) {
        throw new RiskServiceError(
          "UNSUPPORTED_ASSET",
          400,
          `assetCode must be one of ${this.catalog.listAssetCodes().join(", ")}`
        );
      }
    }
    const source = command.source === "automatic" ? "automatic" : "manual";
    const reason = command.reason?.trim() ? command.reason.trim().slice(0, 500) : null;
    const operator = command.operator?.trim() || (source === "automatic" ? "system" : "unknown");
    const at = this.now().toISOString();

    this.cache = null;
    const existing = (await this.repository.listActive()).find(
      (entry) => controlSwitchKey(entry.scope, entry.assetCode) === controlSwitchKey(command.scope, assetCode)
    );

    let result: SetControlSwitchResult;
    if (command.enabled) {
      if (!reason) {
        throw new RiskServiceError(
          "CONTROL_SWITCH_REASON_REQUIRED",
          400,
          "A reason is required to turn an emergency switch on"
        );
      }
      if (existing && source === "automatic") {
        result = { changed: false, entry: existing };
      } else {
        const entry = await this.repository.enable({
          scope: command.scope,
          assetCode,
          reason,
          source,
          updatedBy: operator,
          updatedAt: at
        });
        result = { changed: true, entry };
      }
    } else if (!existing) {
      result = { changed: false, entry: null };
    } else if (source === "automatic") {
      throw new RiskServiceError(
        "CONTROL_SWITCH_MANUAL_RESUME_REQUIRED",
        409,
        "Automatic jobs cannot turn an emergency switch off; an operator must resume it"
      );
    } else {
      await this.repository.disable({ scope: command.scope, assetCode, reason, source, operator, at });
      result = { changed: true, entry: null };
    }

    this.cache = null;
    return { ...result, state: await this.getState() };
  }

  private async loadActive(): Promise<ControlSwitchEntry[]> {
    const nowMs = Date.now();
    if (this.cache && this.cache.expiresAt > nowMs) {
      return this.cache.entries;
    }
    const entries = await this.repository.listActive();
    this.cache = { entries, expiresAt: nowMs + this.cacheMs };
    return entries;
  }
}
