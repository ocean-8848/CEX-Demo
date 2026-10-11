import type { Network } from "@web3-cex/domain";

import { CustodyError } from "../domain/errors.js";
import type { CustodyProviderResolver } from "../domain/provider.js";
import type { CustodyProviderHealthWorker } from "./custody-provider-health-worker.js";
import type {
  CustodyProviderRouteRuntimeSnapshot,
  CustodyProviderRuntimeRegistry
} from "./custody-provider-runtime-registry.js";

/**
 * Fault lab for custody routing.
 *
 * An injected fault makes one (mock) provider fail every broadcast and report
 * itself unhealthy, which is what a custody vendor outage looks like from the
 * exchange's side. The runtime registry then counts consecutive failures,
 * opens the circuit at CUSTODY_PROVIDER_FAILURE_THRESHOLD and the resolver
 * routes new transfers to the next provider by priority.
 *
 * Only providers whose name starts with "mock-" can be injected, and every
 * injection expires on its own, so the lab can never break a real hot wallet.
 */
export interface CustodyFaultInjection {
  providerName: string;
  injectedAt: string;
  expiresAt: string;
  reason?: string;
  requestedBy?: string;
  failedCallCount: number;
}

export interface CustodyFaultInjectorOptions {
  now?: () => Date;
  enabled?: boolean;
  injectableProviders: string[];
  defaultDurationMs?: number;
  maxDurationMs?: number;
}

const MIN_DURATION_MS = 5_000;

export class CustodyFaultInjector {
  private readonly now: () => Date;
  readonly enabled: boolean;
  readonly injectableProviders: string[];
  readonly defaultDurationMs: number;
  readonly maxDurationMs: number;
  private readonly injections = new Map<string, CustodyFaultInjection>();

  constructor(options: CustodyFaultInjectorOptions) {
    this.now = options.now ?? (() => new Date());
    this.enabled = options.enabled ?? true;
    this.injectableProviders = options.injectableProviders.filter((name) =>
      name.startsWith("mock-")
    );
    this.maxDurationMs = Math.max(positiveOr(options.maxDurationMs, 10 * 60_000), MIN_DURATION_MS);
    this.defaultDurationMs = clamp(
      positiveOr(options.defaultDurationMs, 3 * 60_000),
      MIN_DURATION_MS,
      this.maxDurationMs
    );
  }

  inject(command: {
    providerName?: string;
    durationMs?: number;
    reason?: string;
    requestedBy?: string;
  }): CustodyFaultInjection {
    if (!this.enabled) {
      throw new CustodyError(
        "FAULT_LAB_DISABLED",
        "Fault lab is disabled (CUSTODY_FAULT_LAB_ENABLED=false)"
      );
    }

    const providerName = command.providerName?.trim() || this.injectableProviders[0];
    if (!providerName || !this.injectableProviders.includes(providerName)) {
      throw new CustodyError(
        "FAULT_LAB_INVALID_TARGET",
        `Provider ${providerName ?? "(none)"} cannot be fault-injected; allowed: ${this.injectableProviders.join(", ") || "(none)"}`
      );
    }

    const now = this.now();
    const durationMs = clamp(
      positiveOr(command.durationMs, this.defaultDurationMs),
      MIN_DURATION_MS,
      this.maxDurationMs
    );
    const existing = this.getActiveInjection(providerName);
    const injection: CustodyFaultInjection = {
      providerName,
      injectedAt: existing?.injectedAt ?? now.toISOString(),
      expiresAt: new Date(now.getTime() + durationMs).toISOString(),
      reason: command.reason?.trim() || "fault lab",
      requestedBy: command.requestedBy?.trim() || undefined,
      failedCallCount: existing?.failedCallCount ?? 0
    };
    this.injections.set(providerName, injection);
    return { ...injection };
  }

  /** Clears one provider's fault, or all of them; returns the cleared names. */
  clear(providerName?: string): string[] {
    const cleared = this.listActive()
      .map((injection) => injection.providerName)
      .filter((name) => !providerName || name === providerName);
    for (const name of cleared) {
      this.injections.delete(name);
    }
    return cleared;
  }

  getActiveInjection(providerName: string): CustodyFaultInjection | undefined {
    const injection = this.injections.get(providerName);
    if (!injection) {
      return undefined;
    }
    if (Date.parse(injection.expiresAt) <= this.now().getTime()) {
      this.injections.delete(providerName);
      return undefined;
    }
    return injection;
  }

  /** Called by fault-aware providers before doing real work. */
  assertNotInjected(providerName: string, operation: "broadcast"): void {
    const injection = this.getActiveInjection(providerName);
    if (!injection) {
      return;
    }
    injection.failedCallCount += 1;
    throw new CustodyError(
      "PROVIDER_BROADCAST_FAILED",
      `Fault lab: injected ${operation} failure for ${providerName} (until ${injection.expiresAt})`
    );
  }

  listActive(): CustodyFaultInjection[] {
    return [...this.injections.keys()]
      .map((name) => this.getActiveInjection(name))
      .filter((item): item is CustodyFaultInjection => item !== undefined)
      .map((item) => ({ ...item }));
  }
}

export interface CustodyProbeAttempt {
  attempt: number;
  providerName?: string;
  outcome: "succeeded" | "failed" | "no_route" | "skipped_real_provider";
  errorCode?: string;
  errorMessage?: string;
  circuitStateAfter?: string;
  consecutiveFailuresAfter?: number;
}

export class CustodyFaultLab {
  private readonly now: () => Date;

  constructor(
    private readonly injector: CustodyFaultInjector,
    private readonly providerResolver: CustodyProviderResolver,
    private readonly runtimeRegistry: CustodyProviderRuntimeRegistry,
    private readonly healthWorker: CustodyProviderHealthWorker,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  getState(network?: Network) {
    return {
      generatedAt: this.now().toISOString(),
      enabled: this.injector.enabled,
      injectableProviders: [...this.injector.injectableProviders],
      defaultDurationMs: this.injector.defaultDurationMs,
      maxDurationMs: this.injector.maxDurationMs,
      injections: this.injector.listActive(),
      routes: this.listRoutes(network)
    };
  }

  inject(command: {
    providerName?: string;
    durationMs?: number;
    reason?: string;
    requestedBy?: string;
  }) {
    const injection = this.injector.inject(command);
    return { injection, ...this.getState() };
  }

  /**
   * Clears faults and runs a health check right away: a healthy check resets
   * consecutive failures and closes the circuit, so routing returns to the
   * primary provider without waiting for CUSTODY_PROVIDER_CIRCUIT_OPEN_MS.
   */
  async clear(providerName?: string) {
    const cleared = this.injector.clear(providerName);
    const healthCheck = await this.healthWorker.runOnce();
    return { cleared, healthCheck, ...this.getState() };
  }

  /**
   * Sends `count` dry-run broadcasts through the normal route selection so the
   * circuit breaker can be watched without creating withdrawals. Probes only
   * ever reach mock providers; if routing picks a real one, probing stops.
   */
  async probeBroadcast(command: { network?: Network; count?: number }) {
    const network: Network = command.network ?? "ethereum";
    const count = clamp(Math.trunc(command.count ?? 3), 1, 10);
    const attempts: CustodyProbeAttempt[] = [];

    for (let attempt = 1; attempt <= count; attempt += 1) {
      const probeId = `fault-lab-probe:${this.now().getTime()}:${attempt}`;
      let providerName: string | undefined;
      try {
        const provider = this.providerResolver.selectProviderForCreate({
          referenceId: probeId,
          assetCode: "ETH",
          network,
          toAddress: "0x000000000000000000000000000000000000dEaD",
          amount: "0.000001",
          fee: "0",
          idempotencyKey: probeId
        });
        providerName = provider.providerName;
        if (!this.injector.injectableProviders.includes(provider.providerName)) {
          attempts.push({ attempt, providerName, outcome: "skipped_real_provider" });
          break;
        }

        const startedAt = this.now().getTime();
        try {
          await provider.createTransfer({
            custodyTransferId: probeId,
            referenceId: probeId,
            assetCode: "ETH",
            network,
            toAddress: "0x000000000000000000000000000000000000dEaD",
            amount: "0.000001",
            fee: "0",
            metadata: { faultLabProbe: true }
          });
          this.runtimeRegistry.recordOperationResult({
            providerName,
            network,
            operation: "broadcast",
            success: true,
            latencyMs: this.now().getTime() - startedAt
          });
          attempts.push({ attempt, providerName, outcome: "succeeded" });
        } catch (error) {
          const code = error instanceof CustodyError ? error.code : "PROVIDER_BROADCAST_FAILED";
          const message = error instanceof Error ? error.message : "probe broadcast failed";
          this.runtimeRegistry.recordOperationResult({
            providerName,
            network,
            operation: "broadcast",
            success: false,
            latencyMs: this.now().getTime() - startedAt,
            errorCode: code,
            errorMessage: message
          });
          attempts.push({ attempt, providerName, outcome: "failed", errorCode: code, errorMessage: message });
        }
      } catch (error) {
        attempts.push({
          attempt,
          providerName,
          outcome: "no_route",
          errorCode: error instanceof CustodyError ? error.code : undefined,
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      const last = attempts[attempts.length - 1];
      if (last && providerName) {
        const snapshot = this.runtimeRegistry.getRouteSnapshot(providerName, network);
        last.circuitStateAfter = snapshot.circuitState;
        last.consecutiveFailuresAfter = snapshot.consecutiveFailures;
      }
    }

    return { network, attempts, ...this.getState(network) };
  }

  private listRoutes(network?: Network): CustodyProviderRouteRuntimeSnapshot[] {
    return this.runtimeRegistry
      .listRouteSnapshots()
      .filter((route) => !network || route.network === network);
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
