import { createInternalServiceAuthHeaders } from "./index.js";

/**
 * Emergency switches (运营紧急开关). risk-service owns and persists them;
 * wallet-service, api-gateway and risk's own pre-trade check read them through
 * `CachedControlSwitchReader` and enforce them with the pure gates below.
 *
 * - `withdrawals_global`: pause every withdrawal (request, approval, broadcast)
 * - `withdrawals_asset`:  pause one asset's withdrawals (manual, or automatic
 *                         from the reconciliation circuit breaker)
 * - `api_write`:          read-only mode: new orders and withdrawal requests
 *                         are rejected; cancels and reads keep working
 */
export type ControlSwitchScope = "withdrawals_global" | "withdrawals_asset" | "api_write";

/** `automatic` = set by a system job (reconciliation breaker), not by a person. */
export type ControlSwitchSource = "manual" | "automatic";

export const CONTROL_SWITCH_SCOPES: ControlSwitchScope[] = [
  "withdrawals_global",
  "withdrawals_asset",
  "api_write"
];

export interface ControlSwitchEntry {
  scope: ControlSwitchScope;
  /** Only for `withdrawals_asset`. */
  assetCode?: string;
  reason: string | null;
  source: ControlSwitchSource;
  updatedBy: string;
  updatedAt: string;
}

/** Every switch that is currently ON. An empty state means business as usual. */
export interface ControlSwitchState {
  generatedAt: string;
  withdrawalsPaused: ControlSwitchEntry | null;
  assetWithdrawalPauses: ControlSwitchEntry[];
  apiWriteFrozen: ControlSwitchEntry | null;
}

export type ControlSwitchErrorCode =
  | "WITHDRAWALS_PAUSED"
  | "ASSET_WITHDRAWALS_PAUSED"
  | "API_WRITE_FROZEN";

export interface ControlSwitchRejection {
  code: ControlSwitchErrorCode;
  message: string;
  entry: ControlSwitchEntry;
}

/** HTTP status the gates map to (same family as MARKET_HALTED). */
export const CONTROL_SWITCH_HTTP_STATUS = 409;

export function emptyControlSwitchState(generatedAt = new Date().toISOString()): ControlSwitchState {
  return {
    generatedAt,
    withdrawalsPaused: null,
    assetWithdrawalPauses: [],
    apiWriteFrozen: null
  };
}

export function controlSwitchKey(scope: ControlSwitchScope, assetCode?: string): string {
  return scope === "withdrawals_asset" ? `${scope}:${(assetCode ?? "").toUpperCase()}` : scope;
}

/** Builds the state view from a flat list of active switches. */
export function buildControlSwitchState(
  entries: ControlSwitchEntry[],
  generatedAt = new Date().toISOString()
): ControlSwitchState {
  const state = emptyControlSwitchState(generatedAt);
  for (const entry of entries) {
    if (entry.scope === "withdrawals_global") {
      state.withdrawalsPaused = entry;
    } else if (entry.scope === "api_write") {
      state.apiWriteFrozen = entry;
    } else if (entry.scope === "withdrawals_asset" && entry.assetCode) {
      state.assetWithdrawalPauses.push(entry);
    }
  }
  state.assetWithdrawalPauses.sort((left, right) =>
    String(left.assetCode).localeCompare(String(right.assetCode))
  );
  return state;
}

export function findAssetWithdrawalPause(
  state: ControlSwitchState,
  assetCode: string
): ControlSwitchEntry | null {
  const normalized = assetCode.trim().toUpperCase();
  return state.assetWithdrawalPauses.find((entry) => entry.assetCode?.toUpperCase() === normalized) ?? null;
}

/**
 * Withdrawal gate: global pause first, then the asset pause. Used for the
 * user request AND for ops approval / broadcast, so a pause also holds
 * withdrawals that are already in the review queue.
 */
export function evaluateWithdrawalGate(
  state: ControlSwitchState,
  assetCode: string
): ControlSwitchRejection | null {
  if (state.withdrawalsPaused) {
    return {
      code: "WITHDRAWALS_PAUSED",
      message: `All withdrawals are paused${formatReason(state.withdrawalsPaused)}`,
      entry: state.withdrawalsPaused
    };
  }
  const assetPause = findAssetWithdrawalPause(state, assetCode);
  if (assetPause) {
    return {
      code: "ASSET_WITHDRAWALS_PAUSED",
      message: `${assetCode.toUpperCase()} withdrawals are paused${formatReason(assetPause)}`,
      entry: assetPause
    };
  }
  return null;
}

/** API write freeze gate: new orders and withdrawal requests. Cancels never call it. */
export function evaluateApiWriteGate(state: ControlSwitchState): ControlSwitchRejection | null {
  if (!state.apiWriteFrozen) {
    return null;
  }
  return {
    code: "API_WRITE_FROZEN",
    message: `The exchange is in read-only mode${formatReason(state.apiWriteFrozen)}; cancels are still allowed`,
    entry: state.apiWriteFrozen
  };
}

function formatReason(entry: ControlSwitchEntry): string {
  return entry.reason ? ` (${entry.reason})` : "";
}

export type ControlSwitchLoader = () => Promise<ControlSwitchState>;

export interface ControlSwitchReader {
  getState(): Promise<ControlSwitchState>;
}

/**
 * Reads switches through a short cache so every guarded request does not hit
 * risk-service. On a failed refresh it keeps the last known state; if it has
 * never loaded one it fails open (no switch active) and reports the error,
 * which keeps the demo usable while risk-service restarts.
 */
export class CachedControlSwitchReader implements ControlSwitchReader {
  private cached: { state: ControlSwitchState; expiresAt: number } | null = null;
  private lastKnown: ControlSwitchState | null = null;
  private inFlight: Promise<ControlSwitchState> | null = null;
  private readonly cacheMs: number;
  private readonly nowMs: () => number;

  constructor(
    private readonly load: ControlSwitchLoader,
    private readonly options: {
      cacheMs?: number;
      onError?: (error: unknown) => void;
      nowMs?: () => number;
    } = {}
  ) {
    this.cacheMs = Math.max(options.cacheMs ?? 2000, 0);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async getState(): Promise<ControlSwitchState> {
    const now = this.nowMs();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.state;
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh(now).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Drops the cache, e.g. right after this process changed a switch. */
  invalidate(): void {
    this.cached = null;
  }

  private async refresh(now: number): Promise<ControlSwitchState> {
    try {
      const state = await this.load();
      this.lastKnown = state;
      this.cached = { state, expiresAt: now + this.cacheMs };
      return state;
    } catch (error) {
      this.options.onError?.(error);
      const fallback = this.lastKnown ?? emptyControlSwitchState(new Date(now).toISOString());
      // Retry soon, but not on every request.
      this.cached = { state: fallback, expiresAt: now + Math.min(this.cacheMs, 1000) };
      return fallback;
    }
  }
}

export const CONTROL_SWITCHES_PATH = "/api/v1/risk/controls";

/**
 * Loader for `GET /api/v1/risk/controls`, signed with the internal HMAC
 * headers (`INTERNAL_SERVICE_AUTH_SECRET` / `INTERNAL_SERVICE_CALLER_NAME`).
 */
export function createHttpControlSwitchLoader(options: {
  baseUrl: string;
  callerName: string;
  secret?: string;
  timeoutMs?: number;
}): ControlSwitchLoader {
  return async () => {
    const secret = options.secret ?? process.env.INTERNAL_SERVICE_AUTH_SECRET;
    if (!secret) {
      throw new Error("INTERNAL_SERVICE_AUTH_SECRET is required to read control switches");
    }
    const headers = createInternalServiceAuthHeaders({
      secret,
      callerName: process.env.INTERNAL_SERVICE_CALLER_NAME ?? options.callerName,
      method: "GET",
      path: CONTROL_SWITCHES_PATH,
      headers: { accept: "application/json" }
    });
    const response = await fetch(`${options.baseUrl}${CONTROL_SWITCHES_PATH}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000)
    });
    if (!response.ok) {
      throw new Error(`risk-service control switches responded ${response.status}`);
    }
    return normalizeControlSwitchState(await response.json());
  };
}

/** Defensive parse of a state payload (unknown fields ignored). */
export function normalizeControlSwitchState(payload: unknown): ControlSwitchState {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const entry = (value: unknown): ControlSwitchEntry | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const item = value as Record<string, unknown>;
    if (!CONTROL_SWITCH_SCOPES.includes(item.scope as ControlSwitchScope)) {
      return null;
    }
    return {
      scope: item.scope as ControlSwitchScope,
      assetCode: typeof item.assetCode === "string" ? item.assetCode : undefined,
      reason: typeof item.reason === "string" ? item.reason : null,
      source: item.source === "automatic" ? "automatic" : "manual",
      updatedBy: typeof item.updatedBy === "string" ? item.updatedBy : "unknown",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString()
    };
  };
  return {
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date().toISOString(),
    withdrawalsPaused: entry(record.withdrawalsPaused),
    assetWithdrawalPauses: (Array.isArray(record.assetWithdrawalPauses) ? record.assetWithdrawalPauses : [])
      .map(entry)
      .filter((item): item is ControlSwitchEntry => item !== null && Boolean(item.assetCode)),
    apiWriteFrozen: entry(record.apiWriteFrozen)
  };
}
