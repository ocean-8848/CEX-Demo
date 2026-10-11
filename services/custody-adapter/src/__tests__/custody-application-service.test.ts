import test from "node:test";
import assert from "node:assert/strict";

import { CustodyApplicationService } from "../application/custody-application-service.js";
import { CustodyError } from "../domain/errors.js";
import type { CustodyProvider } from "../domain/provider.js";
import type {
  CustodyProviderCreateTransferCommand,
  CustodyProviderCreateTransferResult,
  CustodyProviderHealthcheckCommand,
  CustodyProviderHealthcheckResult,
  CustodyProviderTransferStatusCommand,
  CustodyProviderTransferStatusResult
} from "../domain/types.js";
import { InMemoryCustodyRepository } from "../infrastructure/in-memory-custody-repository.js";

function createProvider(handlers: {
  createTransfer?: (
    command: CustodyProviderCreateTransferCommand
  ) => Promise<CustodyProviderCreateTransferResult>;
  getTransferStatus?: (
    command: CustodyProviderTransferStatusCommand
  ) => Promise<CustodyProviderTransferStatusResult>;
  checkHealth?: (
    command: CustodyProviderHealthcheckCommand
  ) => Promise<CustodyProviderHealthcheckResult>;
} = {}): CustodyProvider {
  return {
    providerName: "mock-custody",
    supportsNetwork() {
      return true;
    },
    async createTransfer(command) {
      if (handlers.createTransfer) {
        return handlers.createTransfer(command);
      }

      return {
        providerName: "mock-custody",
        providerTransferId: "provider-transfer-1",
        status: "broadcasted",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        requestPayload: {
          referenceId: command.referenceId
        },
        responsePayload: {
          txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      };
    },
    async getTransferStatus(command) {
      if (handlers.getTransferStatus) {
        return handlers.getTransferStatus(command);
      }

      return {
        providerName: "mock-custody",
        providerTransferId: command.providerTransferId,
        status: "confirmed",
        txHash: command.txHash,
        responsePayload: {
          status: "confirmed"
        }
      };
    },
    async checkHealth(command) {
      if (handlers.checkHealth) {
        return handlers.checkHealth(command);
      }

      return {
        providerName: "mock-custody",
        network: command.network,
        status: "healthy",
        latencyMs: 0
      };
    }
  };
}

test("createTransfer returns broadcasted transfer with audit attempt", async () => {
  const service = new CustodyApplicationService(
    new InMemoryCustodyRepository(),
    createProvider(),
    {
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `custody-id-${++counter}`;
      })()
    }
  );

  const transfer = await service.createTransfer({
    referenceId: "withdrawal-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x1111111111111111111111111111111111111111",
    amount: "10",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-1"
  });

  assert.equal(transfer.custodyTransferId, "custody-id-1");
  assert.equal(transfer.status, "broadcasted");
  assert.equal(transfer.txHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(transfer.attemptCount, 1);
  assert.equal(transfer.attempts?.length, 1);
  assert.equal(transfer.attempts?.[0]?.action, "broadcast");
});

test("createTransfer is idempotent by idempotency key", async () => {
  let providerCalls = 0;
  const service = new CustodyApplicationService(
    new InMemoryCustodyRepository(),
    createProvider({
      async createTransfer(command) {
        providerCalls += 1;
        return {
          providerName: "mock-custody",
          providerTransferId: `provider-${providerCalls}`,
          status: "broadcasted",
          txHash: `0x${String(providerCalls).padStart(64, "a")}`,
          requestPayload: {
            referenceId: command.referenceId
          },
          responsePayload: {
            providerCalls
          }
        };
      }
    }),
    {
      createId: (() => {
        let counter = 0;
        return () => `custody-id-${++counter}`;
      })()
    }
  );

  const first = await service.createTransfer({
    referenceId: "withdrawal-2",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x2222222222222222222222222222222222222222",
    amount: "15",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-2"
  });
  const second = await service.createTransfer({
    referenceId: "withdrawal-2",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x2222222222222222222222222222222222222222",
    amount: "15",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-2"
  });

  assert.equal(providerCalls, 1);
  assert.equal(first.custodyTransferId, second.custodyTransferId);
  assert.equal(first.txHash, second.txHash);
  assert.equal(second.attempts?.length, 1);
});

test("retryTransfer rebroadcasts a failed transfer and clears retry markers", async () => {
  let createCalls = 0;
  const service = new CustodyApplicationService(
    new InMemoryCustodyRepository(),
    createProvider({
      async createTransfer() {
        createCalls += 1;
        if (createCalls === 1) {
          throw new CustodyError("PROVIDER_BROADCAST_FAILED", "temporary RPC failure");
        }

        return {
          providerName: "mock-custody",
          providerTransferId: "provider-transfer-retry",
          status: "broadcasted",
          txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          responsePayload: {
            txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          }
        };
      }
    }),
    {
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `custody-id-${++counter}`;
      })(),
      maxBroadcastAttempts: 3,
      retryDelayMs: 60_000
    }
  );

  await assert.rejects(
    () =>
      service.createTransfer({
        referenceId: "withdrawal-3",
        assetCode: "USDT",
        network: "ethereum",
        toAddress: "0x3333333333333333333333333333333333333333",
        amount: "25",
        fee: "0.5",
        idempotencyKey: "withdrawal:withdrawal-3"
      }),
    /temporary RPC failure/
  );

  const failed = await service.getTransfer("custody-id-1");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attemptCount, 1);
  assert.ok(failed?.nextRetryAt);

  const retried = await service.retryTransfer({
    custodyTransferId: "custody-id-1",
    requestedBy: "operator-1",
    reason: "manual retry"
  });

  assert.equal(retried.status, "broadcasted");
  assert.equal(retried.attemptCount, 2);
  assert.equal(retried.nextRetryAt, undefined);
  assert.equal(retried.txHash, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(retried.attempts?.length, 2);
  assert.equal(retried.attempts?.[1]?.action, "retry");
});

test("syncTransferStatus marks a broadcasted transfer confirmed", async () => {
  const service = new CustodyApplicationService(
    new InMemoryCustodyRepository(),
    createProvider({
      async getTransferStatus(command) {
        return {
          providerName: "mock-custody",
          providerTransferId: command.providerTransferId ?? command.txHash,
          status: "confirmed",
          txHash: command.txHash,
          responsePayload: {
            status: "confirmed",
            blockNumber: "123"
          }
        };
      }
    }),
    {
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `custody-id-${++counter}`;
      })()
    }
  );

  const created = await service.createTransfer({
    referenceId: "withdrawal-4",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0x4444444444444444444444444444444444444444",
    amount: "30",
    fee: "0.5",
    idempotencyKey: "withdrawal:withdrawal-4"
  });

  const synced = await service.syncTransferStatus({
    custodyTransferId: created.custodyTransferId,
    requestedBy: "indexer"
  });

  assert.equal(synced.status, "confirmed");
  assert.equal(synced.confirmedAt, "2026-03-08T00:00:00.000Z");
  assert.equal(synced.lastSyncedAt, "2026-03-08T00:00:00.000Z");
  assert.equal(synced.attempts?.length, 2);
  assert.equal(synced.attempts?.[1]?.action, "sync_status");
});
