import test from "node:test";
import assert from "node:assert/strict";

import { CustodyApplicationService } from "../application/custody-application-service.js";
import { CustodyProviderHealthWorker } from "../application/custody-provider-health-worker.js";
import { CustodyProviderRuntimeRegistry } from "../application/custody-provider-runtime-registry.js";
import { CustodyTransferSyncWorker } from "../application/custody-transfer-sync-worker.js";
import type { CustodyProvider } from "../domain/provider.js";
import { InMemoryCustodyRepository } from "../infrastructure/in-memory-custody-repository.js";
import {
  ConfiguredCustodyProviderResolver,
  type CustodyProviderRoutingConfig
} from "../infrastructure/custody-provider-resolver.js";

function createProvider(providerName: string): CustodyProvider {
  return {
    providerName,
    supportsNetwork() {
      return true;
    },
    async createTransfer(command) {
      return {
        providerName,
        providerTransferId: `${providerName}:transfer`,
        status: "broadcasted",
        txHash: `0x${providerName.replace(/[^a-z0-9]/gi, "a").padEnd(64, "b").slice(0, 64)}`,
        requestPayload: {
          referenceId: command.referenceId
        },
        responsePayload: {
          providerName
        }
      };
    },
    async getTransferStatus(command) {
      return {
        providerName,
        providerTransferId: command.providerTransferId,
        status: "confirmed",
        txHash: command.txHash,
        responsePayload: {
          providerName,
          status: "confirmed"
        }
      };
    },
    async checkHealth(command) {
      return {
        providerName,
        network: command.network,
        status: "healthy",
        latencyMs: 1
      };
    }
  };
}

test("configured custody provider resolver routes by network and falls back on retry", () => {
  const evmProvider = createProvider("evm-hot-wallet");
  const mockProvider = createProvider("mock-custody");
  const config: CustodyProviderRoutingConfig = {
    defaultOrder: ["mock-custody"],
    orderByNetwork: {
      ethereum: ["evm-hot-wallet", "mock-custody"]
    }
  };
  const resolver = new ConfiguredCustodyProviderResolver(
    [mockProvider, evmProvider],
    config
  );

  const createProviderResult = resolver.selectProviderForCreate({
    referenceId: "withdrawal-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "10",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-1"
  });
  assert.equal(createProviderResult.providerName, "evm-hot-wallet");

  const retryProviderResult = resolver.selectProviderForRetry({
    custodyTransferId: "custody-1",
    referenceId: "withdrawal-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "10",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-1",
    providerName: "evm-hot-wallet",
    status: "failed",
    attemptCount: 1,
    nextRetryAt: "2026-03-08T00:00:00.000Z",
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
    metadata: {}
  });
  assert.equal(retryProviderResult.providerName, "mock-custody");
});

test("configured custody provider resolver skips routes with open circuit and falls back", () => {
  const evmProvider = createProvider("evm-hot-wallet");
  const mockProvider = createProvider("mock-custody");
  const config: CustodyProviderRoutingConfig = {
    defaultOrder: ["mock-custody"],
    orderByNetwork: {
      ethereum: ["evm-hot-wallet", "mock-custody"]
    }
  };
  const bootstrapResolver = new ConfiguredCustodyProviderResolver(
    [mockProvider, evmProvider],
    config
  );
  const runtimeRegistry = new CustodyProviderRuntimeRegistry(bootstrapResolver.listProviderRoutes(), {
    now: () => new Date("2026-03-08T00:00:00.000Z"),
    failureThreshold: 1,
    circuitOpenMs: 300_000
  });
  runtimeRegistry.recordOperationResult({
    providerName: "evm-hot-wallet",
    network: "ethereum",
    operation: "broadcast",
    success: false,
    errorCode: "PROVIDER_BROADCAST_FAILED",
    errorMessage: "rpc offline"
  });

  const resolver = new ConfiguredCustodyProviderResolver(
    [mockProvider, evmProvider],
    config,
    runtimeRegistry
  );

  const selected = resolver.selectProviderForCreate({
    referenceId: "withdrawal-circuit-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "10",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-circuit-1"
  });

  assert.equal(selected.providerName, "mock-custody");
});

test("custody transfer sync worker retries failed transfers and syncs broadcasted ones", async () => {
  const repository = new InMemoryCustodyRepository();
  const service = new CustodyApplicationService(repository, createProvider("mock-custody"), {
    now: () => new Date("2026-03-08T00:00:00.000Z"),
    createId: (() => {
      let counter = 0;
      return () => `custody-id-${++counter}`;
    })()
  });

  const created = await service.createTransfer({
    referenceId: "withdrawal-sync-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "10",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-sync-1"
  });

  await repository.saveTransfer({
    custodyTransferId: "custody-id-failed",
    referenceId: "withdrawal-sync-2",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x2222222222222222222222222222222222222222",
    amount: "12",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-sync-2",
    providerName: "mock-custody",
    status: "failed",
    attemptCount: 1,
    nextRetryAt: "2026-03-07T23:59:00.000Z",
    createdAt: "2026-03-07T23:58:00.000Z",
    updatedAt: "2026-03-07T23:58:00.000Z",
    metadata: {}
  });

  const worker = new CustodyTransferSyncWorker(repository, service, {
    now: () => new Date("2026-03-08T00:01:00.000Z"),
    syncIntervalMs: 1
  });

  const result = await worker.runOnce();
  const synced = await service.getTransfer(created.custodyTransferId);
  const retried = await service.getTransfer("custody-id-failed");

  assert.equal(result.retriedCount, 1);
  assert.equal(result.syncedCount, 1);
  assert.equal(synced?.status, "confirmed");
  assert.equal(retried?.status, "broadcasted");
});

test("provider health worker records unhealthy providers in runtime registry", async () => {
  const resolver = new ConfiguredCustodyProviderResolver(
    [
      createProvider("mock-custody"),
      {
        providerName: "evm-hot-wallet",
        supportsNetwork() {
          return true;
        },
        async createTransfer() {
          throw new Error("not used");
        },
        async getTransferStatus() {
          throw new Error("not used");
        },
        async checkHealth(command) {
          return {
            providerName: "evm-hot-wallet",
            network: command.network,
            status: "unhealthy",
            errorCode: "PROVIDER_HEALTHCHECK_FAILED",
            errorMessage: "rpc timeout"
          };
        }
      }
    ],
    {
      defaultOrder: ["mock-custody"],
      orderByNetwork: {
        ethereum: ["evm-hot-wallet", "mock-custody"]
      }
    }
  );
  const runtimeRegistry = new CustodyProviderRuntimeRegistry(resolver.listProviderRoutes(), {
    now: () => new Date("2026-03-08T00:00:00.000Z"),
    failureThreshold: 1,
    circuitOpenMs: 300_000
  });
  const managedResolver = new ConfiguredCustodyProviderResolver(
    [
      createProvider("mock-custody"),
      {
        providerName: "evm-hot-wallet",
        supportsNetwork() {
          return true;
        },
        async createTransfer() {
          throw new Error("not used");
        },
        async getTransferStatus() {
          throw new Error("not used");
        },
        async checkHealth(command) {
          return {
            providerName: "evm-hot-wallet",
            network: command.network,
            status: "unhealthy",
            errorCode: "PROVIDER_HEALTHCHECK_FAILED",
            errorMessage: "rpc timeout"
          };
        }
      }
    ],
    {
      defaultOrder: ["mock-custody"],
      orderByNetwork: {
        ethereum: ["evm-hot-wallet", "mock-custody"]
      }
    },
    runtimeRegistry
  );
  const worker = new CustodyProviderHealthWorker(managedResolver, runtimeRegistry, {
    now: () => new Date("2026-03-08T00:00:00.000Z")
  });

  const result = await worker.runOnce();
  const snapshot = runtimeRegistry.getRouteSnapshot("evm-hot-wallet", "ethereum");

  assert.equal(result.unhealthyCount, 1);
  assert.equal(snapshot.healthStatus, "unhealthy");
  assert.equal(snapshot.circuitState, "open");
});

test("runtime registry tracks operation latencies for SLA reporting", () => {
  const runtimeRegistry = new CustodyProviderRuntimeRegistry(
    [
      {
        providerName: "mock-custody",
        network: "ethereum",
        priority: 0
      }
    ],
    {
      now: () => new Date("2026-03-08T00:00:00.000Z")
    }
  );

  runtimeRegistry.recordOperationResult({
    providerName: "mock-custody",
    network: "ethereum",
    operation: "broadcast",
    success: true,
    latencyMs: 120
  });
  runtimeRegistry.recordOperationResult({
    providerName: "mock-custody",
    network: "ethereum",
    operation: "sync_status",
    success: false,
    latencyMs: 45,
    errorCode: "PROVIDER_STATUS_SYNC_FAILED",
    errorMessage: "temporary rpc timeout"
  });

  const snapshot = runtimeRegistry.getRouteSnapshot("mock-custody", "ethereum");

  assert.equal(snapshot.broadcastLatencyMsTotal, 120);
  assert.equal(snapshot.broadcastLatencySampleCount, 1);
  assert.equal(snapshot.syncLatencyMsTotal, 45);
  assert.equal(snapshot.syncLatencySampleCount, 1);
});
