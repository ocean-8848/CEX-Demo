import test from "node:test";
import assert from "node:assert/strict";

import type { AssetCode } from "@web3-cex/domain";

import { BlockchainIndexerApplicationService } from "../application/blockchain-indexer-application-service.js";
import type {
  EvmBlock,
  EvmClient,
  EvmLog,
  EvmLogFilter,
  EvmTransactionReceipt
} from "../domain/evm-client.js";
import type { WalletClient } from "../domain/wallet-client.js";
import { InMemoryBlockchainIndexerRepository } from "../infrastructure/in-memory-blockchain-indexer-repository.js";

class MockEvmClient implements EvmClient {
  headBlock = 0;
  readonly blocks = new Map<number, EvmBlock>();
  readonly logs: EvmLog[] = [];
  readonly receipts = new Map<string, EvmTransactionReceipt | null>();

  async getBlockNumber(): Promise<number> {
    return this.headBlock;
  }

  async getBlockByNumber(blockNumber: number, _includeTransactions: boolean): Promise<EvmBlock | null> {
    return (
      this.blocks.get(blockNumber) ?? {
        number: blockNumber,
        hash: blockHash(blockNumber),
        parentHash: blockHash(blockNumber - 1),
        transactions: []
      }
    );
  }

  async getLogs(filter: EvmLogFilter): Promise<EvmLog[]> {
    return this.logs.filter((entry) => matchesLogFilter(entry, filter));
  }

  async getTransactionReceipt(txHash: string): Promise<EvmTransactionReceipt | null> {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
}

function createWalletClient(handlers: Partial<WalletClient> = {}): WalletClient {
  return {
    async confirmDeposit() {
      return {
        depositId: "deposit-default-1",
        status: "credited"
      };
    },
    async confirmWithdrawal() {
      return {
        withdrawalId: "withdrawal-default-1",
        status: "confirmed"
      };
    },
    async listDepositAddresses() {
      return {
        items: [],
        total: 0
      };
    },
    async listBroadcastedWithdrawals() {
      return {
        items: [],
        total: 0
      };
    },
    ...handlers
  };
}

function createService(params?: {
  walletClient?: WalletClient;
  evmClient?: EvmClient;
  confirmationThreshold?: number;
  nativeAssetCodes?: Partial<Record<"ethereum" | "bsc" | "base", AssetCode>>;
  tokenContracts?: Partial<
    Record<
      "ethereum" | "bsc" | "base",
      Array<{ assetCode: AssetCode; contractAddress: string; decimals: number }>
    >
  >;
}) {
  const repository = new InMemoryBlockchainIndexerRepository();
  const evmClient = params?.evmClient ?? new MockEvmClient();
  const service = new BlockchainIndexerApplicationService(
    repository,
    params?.walletClient ?? createWalletClient(),
    {
      confirmationThreshold: params?.confirmationThreshold ?? 12,
      now: () => new Date("2026-03-08T00:00:00.000Z"),
      createId: (() => {
        let counter = 0;
        return () => `id_${++counter}`;
      })(),
      evmClientFactory: () => evmClient,
      evmRpcUrls: {
        ethereum: "http://127.0.0.1:8545"
      },
      evmNativeAssetCodes: params?.nativeAssetCodes,
      evmTokenContracts: params?.tokenContracts,
      walletPageSize: 2
    }
  );

  return {
    repository,
    service,
    evmClient
  };
}

test("observeDeposit below threshold stores detection without calling wallet", async () => {
  let walletCalls = 0;
  const { service } = createService({
    walletClient: createWalletClient({
      async confirmDeposit() {
        walletCalls += 1;
        return {
          depositId: "deposit-1",
          status: "credited"
        };
      }
    })
  });

  const observation = await service.observeDeposit({
    network: "ethereum",
    assetCode: "USDT",
    address: "0xabc",
    txHash: "0xtx1",
    amount: "10",
    confirmations: 3
  });

  assert.equal(observation.status, "detected");
  assert.equal(walletCalls, 0);

  const cursor = await service.getScanCursor("deposit", "ethereum");
  assert.equal(cursor, null);
});

test("observeDeposit at threshold confirms via wallet and stores deposit id", async () => {
  const { service } = createService({
    walletClient: createWalletClient({
      async confirmDeposit() {
        return {
          depositId: "deposit-credited-1",
          status: "credited"
        };
      }
    })
  });

  const observation = await service.observeDeposit({
    network: "ethereum",
    assetCode: "USDT",
    address: "0xdef",
    txHash: "0xtx2",
    amount: "25",
    confirmations: 12,
    blockNumber: 123,
    blockHash: blockHash(123)
  });

  assert.equal(observation.status, "credited");
  assert.equal(observation.walletDepositId, "deposit-credited-1");

  const cursor = await service.getScanCursor("deposit", "ethereum");
  assert.equal(cursor?.lastScannedBlock, 123);
  assert.equal(cursor?.lastFinalizedBlock, 123);
});

test("listDepositObservations filters pending entries and manual close removes them from backlog", async () => {
  const { service } = createService();

  const pending = await service.observeDeposit({
    network: "ethereum",
    assetCode: "USDT",
    address: "0xpending",
    txHash: "0xpendingtx",
    amount: "10",
    confirmations: 2,
    blockNumber: 7
  });
  await service.observeDeposit({
    network: "ethereum",
    assetCode: "USDT",
    address: "0xcredited",
    txHash: "0xcreditedtx",
    amount: "11",
    confirmations: 12,
    blockNumber: 8
  });

  const listed = await service.listDepositObservations({
    network: "ethereum",
    status: "pending"
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]?.observationId, pending.observationId);

  const closed = await service.closeDepositObservation({
    observationId: pending.observationId,
    operatedBy: "ops-user-1",
    note: "manual close"
  });
  assert.equal(closed.status, "closed");
  assert.equal(closed.lastManualAction, "closed");
  assert.equal(closed.lastManualActionBy, "ops-user-1");

  const listedAfterClose = await service.listDepositObservations({
    network: "ethereum",
    status: "pending"
  });
  assert.equal(listedAfterClose.total, 0);
});

test("replayDepositObservation credits pending deposits and records manual action", async () => {
  let walletCalls = 0;
  const { service } = createService({
    walletClient: createWalletClient({
      async confirmDeposit(command) {
        walletCalls += 1;
        assert.equal(command.txHash, "0xreplaytx");
        return {
          depositId: "deposit-replayed-1",
          status: "credited"
        };
      }
    })
  });

  const pending = await service.observeDeposit({
    network: "ethereum",
    assetCode: "USDT",
    address: "0xreplay",
    txHash: "0xreplaytx",
    amount: "25",
    confirmations: 2,
    blockNumber: 9
  });

  const replayed = await service.replayDepositObservation({
    observationId: pending.observationId,
    confirmations: 12,
    operatedBy: "ops-user-2",
    note: "retry credit"
  });

  assert.equal(walletCalls, 1);
  assert.equal(replayed.status, "credited");
  assert.equal(replayed.walletDepositId, "deposit-replayed-1");
  assert.equal(replayed.lastManualAction, "replayed");
  assert.equal(replayed.lastManualActionBy, "ops-user-2");
});

test("observeWithdrawal below threshold stores detection without calling wallet", async () => {
  let walletCalls = 0;
  const { service } = createService({
    walletClient: createWalletClient({
      async confirmWithdrawal() {
        walletCalls += 1;
        return {
          withdrawalId: "withdrawal-1",
          status: "confirmed"
        };
      }
    })
  });

  const observation = await service.observeWithdrawal({
    network: "ethereum",
    assetCode: "USDT",
    txHash: "0xwd1",
    confirmations: 5
  });

  assert.equal(observation.status, "detected");
  assert.equal(walletCalls, 0);
});

test("observeWithdrawal records reorg metadata when block hash changes for same tx", async () => {
  const { service } = createService();

  await service.observeWithdrawal({
    network: "ethereum",
    assetCode: "USDT",
    txHash: "0xwd-reorg",
    confirmations: 3,
    blockNumber: 500,
    blockHash: blockHash(500, "a")
  });

  const observation = await service.observeWithdrawal({
    network: "ethereum",
    assetCode: "USDT",
    txHash: "0xwd-reorg",
    confirmations: 4,
    blockNumber: 500,
    blockHash: blockHash(500, "b")
  });

  assert.equal(observation.reorgedFromBlockNumber, 500);
  assert.equal(observation.reorgDetectedAt, "2026-03-08T00:00:00.000Z");
});

test("scanEvmDeposits scans native transfers and ERC20 logs and credits wallet deposits", async () => {
  const depositConfirmations: string[] = [];
  const walletClient = createWalletClient({
    async confirmDeposit(command) {
      depositConfirmations.push(`${command.txHash}:${command.amount}`);
      return {
        depositId: `deposit-${depositConfirmations.length}`,
        status: "credited"
      };
    },
    async listDepositAddresses() {
      return {
        items: [
          {
            address: "0x1111111111111111111111111111111111111111",
            assetCode: "ETH"
          },
          {
            address: "0x2222222222222222222222222222222222222222",
            assetCode: "USDT"
          }
        ],
        total: 2
      };
    }
  });
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 120;
  evmClient.blocks.set(109, {
    number: 109,
    hash: blockHash(109),
    parentHash: blockHash(108),
    transactions: [
      {
        hash: "0xnative-deposit",
        to: "0x1111111111111111111111111111111111111111",
        value: "0xde0b6b3a7640000"
      }
    ]
  });
  evmClient.logs.push({
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      topicAddress("0x9999999999999999999999999999999999999999"),
      topicAddress("0x2222222222222222222222222222222222222222")
    ],
    data: "0x017d7840",
    transactionHash: "0xtoken-deposit",
    blockNumber: 109,
    blockHash: blockHash(109)
  });

  const { repository, service } = createService({
    walletClient,
    evmClient,
    nativeAssetCodes: {
      ethereum: "ETH"
    },
    tokenContracts: {
      ethereum: [
        {
          assetCode: "USDT",
          contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          decimals: 6
        }
      ]
    }
  });

  const result = await service.scanEvmDeposits({
    network: "ethereum",
    fromBlock: 109,
    toBlock: 109
  });

  assert.equal(result.matchedObservationCount, 2);
  assert.equal(result.rolledBackObservationCount, 0);
  assert.equal(result.cursor.lastScannedBlock, 109);
  assert.equal(result.cursor.lastFinalizedBlock, 109);
  assert.equal(depositConfirmations.length, 2);

  const nativeObservation = await repository.findDepositObservationByUniqueKey(
    "ethereum",
    "0xnative-deposit",
    "0x1111111111111111111111111111111111111111"
  );
  const tokenObservation = await repository.findDepositObservationByUniqueKey(
    "ethereum",
    "0xtoken-deposit",
    "0x2222222222222222222222222222222222222222"
  );
  assert.equal(nativeObservation?.amount, "1");
  assert.equal(nativeObservation?.status, "credited");
  assert.equal(tokenObservation?.amount, "25");
  assert.equal(tokenObservation?.status, "credited");
});

test("scanEvmDeposits removes stale non-finalized observations when canonical tx disappears", async () => {
  const walletClient = createWalletClient({
    async listDepositAddresses() {
      return {
        items: [
          {
            address: "0x1111111111111111111111111111111111111111",
            assetCode: "ETH"
          }
        ],
        total: 1
      };
    }
  });
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 120;
  evmClient.blocks.set(115, {
    number: 115,
    hash: blockHash(115, "a"),
    parentHash: blockHash(114),
    transactions: [
      {
        hash: "0xreorg-deposit",
        to: "0x1111111111111111111111111111111111111111",
        value: "0x1"
      }
    ]
  });

  const { repository, service } = createService({
    walletClient,
    evmClient,
    nativeAssetCodes: {
      ethereum: "ETH"
    }
  });

  const firstScan = await service.scanEvmDeposits({
    network: "ethereum",
    fromBlock: 115,
    toBlock: 115
  });

  assert.equal(firstScan.matchedObservationCount, 1);
  const originalObservation = await repository.findDepositObservationByUniqueKey(
    "ethereum",
    "0xreorg-deposit",
    "0x1111111111111111111111111111111111111111"
  );
  assert.equal(originalObservation?.status, "detected");

  evmClient.headBlock = 121;
  evmClient.blocks.set(115, {
    number: 115,
    hash: blockHash(115, "b"),
    parentHash: blockHash(114),
    transactions: []
  });

  const secondScan = await service.scanEvmDeposits({
    network: "ethereum",
    toBlock: 121
  });

  assert.equal(secondScan.rolledBackObservationCount, 1);
  assert.equal(secondScan.reorgDetected, true);
  assert.equal(secondScan.reorgDetectedBlock, 115);
  assert.equal(
    await repository.findDepositObservationByUniqueKey(
      "ethereum",
      "0xreorg-deposit",
      "0x1111111111111111111111111111111111111111"
    ),
    null
  );
});

test("scanEvmWithdrawals confirms tracked withdrawals from receipts", async () => {
  const walletConfirmations: string[] = [];
  const walletClient = createWalletClient({
    async confirmWithdrawal(command) {
      walletConfirmations.push(`${command.txHash}:${command.confirmations}`);
      return {
        withdrawalId: "withdrawal-confirmed-1",
        status: "confirmed"
      };
    },
    async listBroadcastedWithdrawals() {
      return {
        items: [
          {
            txHash: "0xwithdrawal-confirm",
            assetCode: "USDT"
          }
        ],
        total: 1
      };
    }
  });
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 120;
  evmClient.receipts.set("0xwithdrawal-confirm", {
    transactionHash: "0xwithdrawal-confirm",
    blockNumber: 109,
    blockHash: blockHash(109),
    status: 1
  });

  const { repository, service } = createService({
    walletClient,
    evmClient
  });

  const result = await service.scanEvmWithdrawals({
    network: "ethereum"
  });

  assert.equal(result.matchedObservationCount, 1);
  assert.equal(walletConfirmations.length, 1);
  assert.equal(result.cursor.lastFinalizedBlock, 109);

  const observation = await repository.findWithdrawalObservationByUniqueKey(
    "ethereum",
    "0xwithdrawal-confirm"
  );
  assert.equal(observation?.status, "confirmed");
  assert.equal(observation?.walletWithdrawalId, "withdrawal-confirmed-1");
});

test("scanEvmWithdrawals removes stale pending receipts when tx is reorged out", async () => {
  const walletClient = createWalletClient({
    async listBroadcastedWithdrawals() {
      return {
        items: [
          {
            txHash: "0xwithdrawal-reorg",
            assetCode: "USDT"
          }
        ],
        total: 1
      };
    }
  });
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 120;
  evmClient.receipts.set("0xwithdrawal-reorg", {
    transactionHash: "0xwithdrawal-reorg",
    blockNumber: 115,
    blockHash: blockHash(115, "a"),
    status: 1
  });

  const { repository, service } = createService({
    walletClient,
    evmClient
  });

  const firstScan = await service.scanEvmWithdrawals({
    network: "ethereum"
  });
  assert.equal(firstScan.matchedObservationCount, 1);

  evmClient.headBlock = 121;
  evmClient.receipts.set("0xwithdrawal-reorg", null);

  const secondScan = await service.scanEvmWithdrawals({
    network: "ethereum"
  });

  assert.equal(secondScan.rolledBackObservationCount, 1);
  assert.equal(secondScan.reorgDetected, true);
  assert.equal(secondScan.reorgDetectedBlock, 115);
  assert.equal(
    await repository.findWithdrawalObservationByUniqueKey("ethereum", "0xwithdrawal-reorg"),
    null
  );
});

test("runEvmReplay executes deposit and withdrawal scans together", async () => {
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 40;

  const { service } = createService({
    evmClient,
    nativeAssetCodes: {
      ethereum: "ETH"
    }
  });

  const result = await service.runEvmReplay({
    network: "ethereum",
    observationType: "both",
    fromBlock: 40,
    toBlock: 40
  });

  assert.equal(result.network, "ethereum");
  assert.equal(result.observationType, "both");
  assert.equal(result.depositResult?.headBlock, 40);
  assert.equal(result.withdrawalResult?.headBlock, 40);
});

test("repairEvmBacklog replays from cursor lookback window", async () => {
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 90;
  const { repository, service } = createService({
    evmClient,
    nativeAssetCodes: {
      ethereum: "ETH"
    }
  });

  await repository.saveScanCursor({
    cursorId: "cursor-1",
    observationType: "deposit",
    network: "ethereum",
    lastScannedBlock: 80,
    lastFinalizedBlock: 78,
    updatedAt: "2026-03-08T00:00:00.000Z"
  });

  const result = await service.repairEvmBacklog({
    network: "ethereum",
    observationType: "both",
    lookbackBlocks: 5
  });

  assert.equal(result.headBlock, 90);
  assert.equal(result.depositFromBlock, 73);
  assert.equal(result.depositResult?.fromBlock, 73);
  assert.equal(result.withdrawalResult?.headBlock, 90);
});

test("repairEvmBacklog clamps cursor lookback when cursor is ahead of chain head", async () => {
  const evmClient = new MockEvmClient();
  evmClient.headBlock = 12;
  const { repository, service } = createService({
    evmClient,
    nativeAssetCodes: {
      ethereum: "ETH"
    }
  });

  await repository.saveScanCursor({
    cursorId: "cursor-ahead",
    observationType: "deposit",
    network: "ethereum",
    lastScannedBlock: 120,
    lastFinalizedBlock: 118,
    updatedAt: "2026-03-08T00:00:00.000Z"
  });

  const result = await service.repairEvmBacklog({
    network: "ethereum",
    observationType: "deposit",
    lookbackBlocks: 5
  });

  assert.equal(result.headBlock, 12);
  assert.equal(result.depositFromBlock, 7);
  assert.equal(result.depositResult?.fromBlock, 7);
  assert.equal(result.depositResult?.toBlock, 12);
});

function blockHash(blockNumber: number, suffix = ""): string {
  const body = `${Math.max(blockNumber, 0).toString(16).padStart(62, "0")}${suffix}`.slice(0, 64);
  return `0x${body.padEnd(64, "0")}`;
}

function topicAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function matchesLogFilter(log: EvmLog, filter: EvmLogFilter): boolean {
  if (log.blockNumber < filter.fromBlock || log.blockNumber > filter.toBlock) {
    return false;
  }

  if (filter.addresses && !filter.addresses.map((item) => item.toLowerCase()).includes(log.address)) {
    return false;
  }

  if (!filter.topics) {
    return true;
  }

  return filter.topics.every((expected, index) => {
    if (expected === null || expected === undefined) {
      return true;
    }

    const actual = log.topics[index]?.toLowerCase();
    if (!actual) {
      return false;
    }

    if (Array.isArray(expected)) {
      return expected.map((value) => value.toLowerCase()).includes(actual);
    }

    return expected.toLowerCase() === actual;
  });
}

test("a deposit re-included in a new block after a reorg is flagged, re-confirmed and the cursor flag can be acknowledged", async () => {
  let walletCalls = 0;
  const { service } = createService({
    walletClient: createWalletClient({
      async confirmDeposit() {
        walletCalls += 1;
        return { depositId: "deposit-reorg-1", status: "credited" };
      }
    })
  });
  const base = {
    network: "ethereum" as const,
    assetCode: "ETH" as AssetCode,
    address: "0xlab",
    txHash: "0xlab-reorg",
    amount: "0.01"
  };

  await service.observeDeposit({ ...base, confirmations: 6, blockNumber: 100, blockHash: "0xaaa" });
  // Blocks 100..105 were orphaned; the tx landed again in block 100 of the new branch.
  const reorged = await service.observeDeposit({
    ...base,
    confirmations: 1,
    blockNumber: 100,
    blockHash: "0xbbb"
  });
  assert.equal(reorged.status, "detected");
  assert.equal(reorged.confirmations, 1);
  assert.equal(reorged.reorgedFromBlockNumber, 100);
  assert.ok(reorged.reorgDetectedAt);
  assert.equal(walletCalls, 0);
  assert.ok((await service.getScanCursor("deposit", "ethereum"))?.reorgDetectedAt);

  const credited = await service.observeDeposit({
    ...base,
    confirmations: 12,
    blockNumber: 100,
    blockHash: "0xbbb"
  });
  assert.equal(credited.status, "credited");
  assert.equal(walletCalls, 1);

  const acknowledged = await service.acknowledgeReorg("ethereum");
  assert.deepEqual(
    acknowledged.clearedCursors.map((cursor) => cursor.observationType),
    ["deposit"]
  );
  const cursor = await service.getScanCursor("deposit", "ethereum");
  assert.equal(cursor?.reorgDetectedAt, undefined);
  assert.equal((await service.acknowledgeReorg("ethereum")).clearedCursors.length, 0);
});
