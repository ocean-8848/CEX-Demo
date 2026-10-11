import type { Network } from "@web3-cex/domain";

import type { CustodyProviderRoute } from "../domain/provider.js";
import type {
  CustodyProviderCircuitState,
  CustodyProviderHealthStatus,
  CustodyProviderHealthcheckResult
} from "../domain/types.js";

export interface CustodyProviderRouteRuntimeSnapshot {
  providerName: string;
  network: Network;
  priority: number;
  healthStatus: CustodyProviderHealthStatus | "unknown";
  circuitState: CustodyProviderCircuitState;
  consecutiveFailures: number;
  routeSelectionCount: number;
  broadcastSuccessCount: number;
  broadcastFailureCount: number;
  broadcastLatencyMsTotal: number;
  broadcastLatencySampleCount: number;
  syncSuccessCount: number;
  syncFailureCount: number;
  syncLatencyMsTotal: number;
  syncLatencySampleCount: number;
  healthcheckSuccessCount: number;
  healthcheckFailureCount: number;
  healthcheckLatencyMsTotal: number;
  healthcheckLatencySampleCount: number;
  lastHealthCheckedAt?: string;
  lastHealthLatencyMs?: number;
  lastSelectionAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  circuitOpenedAt?: string;
  circuitOpenUntil?: string;
}

interface CustodyProviderRouteRuntimeState extends CustodyProviderRouteRuntimeSnapshot {}

interface RegistryOptions {
  now?: () => Date;
  failureThreshold?: number;
  circuitOpenMs?: number;
}

type ProviderOperation = "broadcast" | "retry" | "sync_status" | "healthcheck";

export class CustodyProviderRuntimeRegistry {
  private readonly now: () => Date;
  private readonly failureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly states = new Map<string, CustodyProviderRouteRuntimeState>();

  constructor(routes: CustodyProviderRoute[], options: RegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.failureThreshold = options.failureThreshold ?? 2;
    this.circuitOpenMs = options.circuitOpenMs ?? 120_000;

    for (const route of routes) {
      this.ensureRoute(route.providerName, route.network, route.priority);
    }
  }

  listRouteSnapshots(): CustodyProviderRouteRuntimeSnapshot[] {
    return [...this.states.values()]
      .map((state) => ({ ...state }))
      .sort((left, right) => {
        const networkOrder = left.network.localeCompare(right.network);
        if (networkOrder !== 0) {
          return networkOrder;
        }

        return left.priority - right.priority;
      });
  }

  getRouteSnapshot(
    providerName: string,
    network: Network
  ): CustodyProviderRouteRuntimeSnapshot {
    return { ...this.touchCircuitState(providerName, network) };
  }

  evaluateRouteAvailability(
    providerName: string,
    network: Network
  ): {
    available: boolean;
    reason?: string;
    snapshot: CustodyProviderRouteRuntimeSnapshot;
  } {
    const snapshot = this.getRouteSnapshot(providerName, network);

    if (snapshot.circuitState === "open" && snapshot.circuitOpenUntil) {
      return {
        available: false,
        reason: `circuit_open_until=${snapshot.circuitOpenUntil}`,
        snapshot
      };
    }

    if (snapshot.healthStatus === "unhealthy") {
      return {
        available: false,
        reason: snapshot.lastErrorCode ?? "provider_unhealthy",
        snapshot
      };
    }

    return {
      available: true,
      snapshot
    };
  }

  markRouteSelected(providerName: string, network: Network): void {
    const state = this.touchCircuitState(providerName, network);
    state.routeSelectionCount += 1;
    state.lastSelectionAt = this.now().toISOString();
  }

  recordOperationResult(params: {
    providerName: string;
    network: Network;
    operation: ProviderOperation;
    success: boolean;
    latencyMs?: number;
    errorCode?: string;
    errorMessage?: string;
  }): void {
    const state = this.touchCircuitState(params.providerName, params.network);
    const now = this.now().toISOString();

    if (params.success) {
      state.consecutiveFailures = 0;
      state.circuitState = "closed";
      state.circuitOpenedAt = undefined;
      state.circuitOpenUntil = undefined;
      state.lastSuccessAt = now;
      state.lastErrorCode = undefined;
      state.lastErrorMessage = undefined;

      if (params.operation === "broadcast" || params.operation === "retry") {
        state.broadcastSuccessCount += 1;
        if (params.latencyMs !== undefined) {
          state.broadcastLatencyMsTotal += params.latencyMs;
          state.broadcastLatencySampleCount += 1;
        }
      } else if (params.operation === "sync_status") {
        state.syncSuccessCount += 1;
        if (params.latencyMs !== undefined) {
          state.syncLatencyMsTotal += params.latencyMs;
          state.syncLatencySampleCount += 1;
        }
      } else {
        state.healthcheckSuccessCount += 1;
        if (params.latencyMs !== undefined) {
          state.healthcheckLatencyMsTotal += params.latencyMs;
          state.healthcheckLatencySampleCount += 1;
        }
      }

      return;
    }

    state.consecutiveFailures += 1;
    state.lastFailureAt = now;
    state.lastErrorCode = params.errorCode;
    state.lastErrorMessage = params.errorMessage;

    if (params.operation === "broadcast" || params.operation === "retry") {
      state.broadcastFailureCount += 1;
      if (params.latencyMs !== undefined) {
        state.broadcastLatencyMsTotal += params.latencyMs;
        state.broadcastLatencySampleCount += 1;
      }
    } else if (params.operation === "sync_status") {
      state.syncFailureCount += 1;
      if (params.latencyMs !== undefined) {
        state.syncLatencyMsTotal += params.latencyMs;
        state.syncLatencySampleCount += 1;
      }
    } else {
      state.healthcheckFailureCount += 1;
      if (params.latencyMs !== undefined) {
        state.healthcheckLatencyMsTotal += params.latencyMs;
        state.healthcheckLatencySampleCount += 1;
      }
    }

    if (state.consecutiveFailures >= this.failureThreshold) {
      state.circuitState = "open";
      state.circuitOpenedAt = now;
      state.circuitOpenUntil = new Date(this.now().getTime() + this.circuitOpenMs).toISOString();
    }
  }

  recordHealthcheck(result: CustodyProviderHealthcheckResult): void {
    const state = this.touchCircuitState(result.providerName, result.network);
    state.lastHealthCheckedAt = this.now().toISOString();
    state.lastHealthLatencyMs = result.latencyMs;
    state.healthStatus = result.status;

    if (result.status === "healthy" || result.status === "degraded") {
      this.recordOperationResult({
        providerName: result.providerName,
        network: result.network,
        operation: "healthcheck",
        success: true,
        latencyMs: result.latencyMs
      });
      return;
    }

    this.recordOperationResult({
      providerName: result.providerName,
      network: result.network,
      operation: "healthcheck",
      success: false,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage
    });
  }

  private touchCircuitState(
    providerName: string,
    network: Network,
    priority = 0
  ): CustodyProviderRouteRuntimeState {
    const key = toRouteKey(providerName, network);
    const state = this.states.get(key) ?? this.ensureRoute(providerName, network, priority);

    if (
      state.circuitState === "open" &&
      state.circuitOpenUntil &&
      state.circuitOpenUntil <= this.now().toISOString()
    ) {
      state.circuitState = "half_open";
      state.circuitOpenUntil = undefined;
    }

    return state;
  }

  private ensureRoute(
    providerName: string,
    network: Network,
    priority: number
  ): CustodyProviderRouteRuntimeState {
    const key = toRouteKey(providerName, network);
    const existing = this.states.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing;
    }

    const created: CustodyProviderRouteRuntimeState = {
      providerName,
      network,
      priority,
      healthStatus: "unknown",
      circuitState: "closed",
      consecutiveFailures: 0,
      routeSelectionCount: 0,
      broadcastSuccessCount: 0,
      broadcastFailureCount: 0,
      broadcastLatencyMsTotal: 0,
      broadcastLatencySampleCount: 0,
      syncSuccessCount: 0,
      syncFailureCount: 0,
      syncLatencyMsTotal: 0,
      syncLatencySampleCount: 0,
      healthcheckSuccessCount: 0,
      healthcheckFailureCount: 0,
      healthcheckLatencyMsTotal: 0,
      healthcheckLatencySampleCount: 0
    };
    this.states.set(key, created);
    return created;
  }
}

function toRouteKey(providerName: string, network: Network): string {
  return `${providerName}:${network}`;
}
