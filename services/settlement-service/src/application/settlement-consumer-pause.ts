import { SettlementServiceError } from "../domain/errors.js";
import type { SettlementConsumerPauseState } from "../domain/types.js";

export type { SettlementConsumerPauseState };

export interface SettlementConsumerPauseOptions {
  now?: () => Date;
  enabled?: boolean;
  defaultDurationMs?: number;
  maxDurationMs?: number;
}

export interface PauseSettlementConsumerCommand {
  durationMs?: number;
  reason?: string;
  requestedBy?: string;
}

const MIN_DURATION_MS = 5_000;

/**
 * Fault-lab switch for the trade event consumer.
 *
 * While paused, automatic subscription cycles are skipped, so new trades pile
 * up as "executed but not settled" (checkpoint lag grows). Nothing is lost:
 * the Redis Stream keeps the entries and the checkpoint still points at the
 * last settled one, so resuming simply catches up. Every pause carries an
 * expiry, so a forgotten experiment heals itself.
 */
export class SettlementConsumerPauseControl {
  private readonly now: () => Date;
  private readonly enabled: boolean;
  private readonly defaultDurationMs: number;
  private readonly maxDurationMs: number;
  private pausedAt?: string;
  private expiresAt?: string;
  private reason?: string;
  private requestedBy?: string;
  private skippedCycleCount = 0;
  private lastResumedAt?: string;
  private lastResumeTrigger?: "manual" | "expired";

  constructor(options: SettlementConsumerPauseOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.enabled = options.enabled ?? true;
    this.maxDurationMs = Math.max(
      normalizePositive(options.maxDurationMs, 10 * 60_000),
      MIN_DURATION_MS
    );
    this.defaultDurationMs = Math.min(
      Math.max(normalizePositive(options.defaultDurationMs, 2 * 60_000), MIN_DURATION_MS),
      this.maxDurationMs
    );
  }

  pause(command: PauseSettlementConsumerCommand = {}): SettlementConsumerPauseState {
    if (!this.enabled) {
      throw new SettlementServiceError(
        "SETTLEMENT_FAULT_LAB_DISABLED",
        403,
        "Fault lab is disabled (SETTLEMENT_FAULT_LAB_ENABLED=false)"
      );
    }

    const durationMs = Math.min(
      Math.max(normalizePositive(command.durationMs, this.defaultDurationMs), MIN_DURATION_MS),
      this.maxDurationMs
    );
    const now = this.now();
    // Re-pausing extends the window but keeps the original start time.
    if (!this.isPaused()) {
      this.pausedAt = now.toISOString();
      this.skippedCycleCount = 0;
    }
    this.expiresAt = new Date(now.getTime() + durationMs).toISOString();
    this.reason = command.reason?.trim() || "fault lab";
    this.requestedBy = command.requestedBy?.trim() || undefined;
    return this.getState();
  }

  resume(trigger: "manual" | "expired" = "manual"): SettlementConsumerPauseState {
    if (this.pausedAt) {
      this.lastResumedAt = this.now().toISOString();
      this.lastResumeTrigger = trigger;
    }
    this.pausedAt = undefined;
    this.expiresAt = undefined;
    this.reason = undefined;
    this.requestedBy = undefined;
    return this.getState();
  }

  /** True while a pause is active; lazily resumes once the expiry has passed. */
  isPaused(): boolean {
    if (!this.pausedAt || !this.expiresAt) {
      return false;
    }
    if (Date.parse(this.expiresAt) <= this.now().getTime()) {
      this.resume("expired");
      return false;
    }
    return true;
  }

  recordSkippedCycle(): void {
    this.skippedCycleCount += 1;
  }

  getState(): SettlementConsumerPauseState {
    const paused = this.isPaused();
    return {
      enabled: this.enabled,
      paused,
      pausedAt: paused ? this.pausedAt : undefined,
      expiresAt: paused ? this.expiresAt : undefined,
      reason: paused ? this.reason : undefined,
      requestedBy: paused ? this.requestedBy : undefined,
      skippedCycleCount: this.skippedCycleCount,
      lastResumedAt: this.lastResumedAt,
      lastResumeTrigger: this.lastResumeTrigger,
      maxDurationMs: this.maxDurationMs,
      defaultDurationMs: this.defaultDurationMs
    };
  }
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}
