import { addAmounts } from "@web3-cex/domain";
import type { Network } from "@web3-cex/domain";

import type { WalletRepository } from "../domain/repository.js";
import type { TreasuryRepository } from "../domain/treasury-repository.js";
import type {
  AssetNetworkAmount,
  ListTreasuryTransfersQuery,
  ProofOfReservesLeaf,
  ProofOfReservesSnapshot,
  SentWithdrawalTotal,
  TreasuryTransferRecord,
  TreasuryTransferTotal,
  UnsweptDeposit
} from "../domain/treasury-types.js";
import type { PagedResult } from "../domain/types.js";

const SCAN_LIMIT = 100_000;

/**
 * Memory-mode treasury store (WALLET_REPOSITORY=memory and unit tests).
 * Deposit / withdrawal facts are read through the wallet repository's public
 * queries, so it works with any WalletRepository.
 */
export class InMemoryTreasuryRepository implements TreasuryRepository {
  private readonly transfers = new Map<string, TreasuryTransferRecord>();
  private readonly sweepLinks = new Map<string, string>();
  private readonly snapshots: ProofOfReservesSnapshot[] = [];
  private readonly leaves = new Map<string, ProofOfReservesLeaf>();

  constructor(private readonly walletRepository: Pick<WalletRepository, "listDeposits" | "listWithdrawals">) {}

  async withTransaction<T>(operation: (repository: TreasuryRepository) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async insertTransfer(record: TreasuryTransferRecord): Promise<void> {
    if ([...this.transfers.values()].some((item) => item.idempotencyKey === record.idempotencyKey)) {
      throw new Error(`duplicate idempotency key ${record.idempotencyKey}`);
    }
    this.transfers.set(record.transferId, structuredClone(record));
  }

  async updateTransfer(record: TreasuryTransferRecord): Promise<void> {
    this.transfers.set(record.transferId, structuredClone(record));
  }

  async findTransferById(transferId: string): Promise<TreasuryTransferRecord | null> {
    const record = this.transfers.get(transferId);
    return record ? structuredClone(record) : null;
  }

  async findTransferByIdempotencyKey(idempotencyKey: string): Promise<TreasuryTransferRecord | null> {
    const record = [...this.transfers.values()].find((item) => item.idempotencyKey === idempotencyKey);
    return record ? structuredClone(record) : null;
  }

  async findTransferByTxHash(network: Network, txHash: string): Promise<TreasuryTransferRecord | null> {
    const record = [...this.transfers.values()].find((item) => item.network === network && item.txHash === txHash);
    return record ? structuredClone(record) : null;
  }

  async listTransfers(query: ListTreasuryTransfersQuery): Promise<PagedResult<TreasuryTransferRecord>> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const statuses = query.statuses?.length ? query.statuses : query.status ? [query.status] : undefined;
    const items = [...this.transfers.values()]
      .filter((item) => !query.kind || item.kind === query.kind)
      .filter((item) => !statuses || statuses.includes(item.status))
      .filter((item) => !query.assetCode || item.assetCode === query.assetCode)
      .filter((item) => !query.network || item.network === query.network)
      .filter((item) => !query.txHash || item.txHash === query.txHash)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      items: items.slice(offset, offset + limit).map((item) => structuredClone(item)),
      total: items.length,
      limit,
      offset
    };
  }

  async listTransferTotals(): Promise<TreasuryTransferTotal[]> {
    const totals = new Map<string, TreasuryTransferTotal>();
    for (const item of this.transfers.values()) {
      const key = [item.kind, item.fromWallet, item.toWallet, item.assetCode, item.network, item.status].join("|");
      const current = totals.get(key) ?? {
        kind: item.kind,
        fromWallet: item.fromWallet,
        toWallet: item.toWallet,
        assetCode: item.assetCode,
        network: item.network,
        status: item.status,
        amount: "0",
        count: 0
      };
      current.amount = addAmounts(current.amount, item.amount);
      current.count += 1;
      totals.set(key, current);
    }
    return [...totals.values()];
  }

  async listUnsweptCreditedDeposits(limit: number): Promise<UnsweptDeposit[]> {
    const { items } = await this.walletRepository.listDeposits({ status: "credited", limit: SCAN_LIMIT });
    return items
      .filter((deposit) => !this.sweepLinks.has(deposit.depositId))
      .sort((left, right) => (left.creditedAt ?? "").localeCompare(right.creditedAt ?? ""))
      .slice(0, limit)
      .map((deposit) => ({
        depositId: deposit.depositId,
        userId: deposit.userId,
        assetCode: deposit.assetCode,
        network: deposit.network,
        address: deposit.address,
        amount: deposit.amount,
        creditedAt: deposit.creditedAt
      }));
  }

  async linkSweepDeposits(transferId: string, depositIds: string[]): Promise<void> {
    const taken = depositIds.find((depositId) => this.sweepLinks.has(depositId));
    if (taken) {
      throw new Error(`deposit ${taken} is already part of a sweep`);
    }
    for (const depositId of depositIds) {
      this.sweepLinks.set(depositId, transferId);
    }
  }

  async unlinkSweepDeposits(transferId: string): Promise<void> {
    for (const [depositId, linked] of [...this.sweepLinks.entries()]) {
      if (linked === transferId) {
        this.sweepLinks.delete(depositId);
      }
    }
  }

  async listSweepDepositIds(transferId: string): Promise<string[]> {
    return [...this.sweepLinks.entries()]
      .filter(([, linked]) => linked === transferId)
      .map(([depositId]) => depositId)
      .sort();
  }

  async sumCreditedDeposits(): Promise<AssetNetworkAmount[]> {
    const { items } = await this.walletRepository.listDeposits({ status: "credited", limit: SCAN_LIMIT });
    const totals = new Map<string, AssetNetworkAmount>();
    for (const deposit of items) {
      const key = `${deposit.assetCode}:${deposit.network}`;
      const current = totals.get(key) ?? { assetCode: deposit.assetCode, network: deposit.network, amount: "0", count: 0 };
      current.amount = addAmounts(current.amount, deposit.amount);
      current.count += 1;
      totals.set(key, current);
    }
    return [...totals.values()];
  }

  async sumSentWithdrawals(): Promise<SentWithdrawalTotal[]> {
    const totals = new Map<string, SentWithdrawalTotal>();
    for (const status of ["broadcasted", "confirmed"] as const) {
      const { items } = await this.walletRepository.listWithdrawals({ status, limit: SCAN_LIMIT });
      for (const withdrawal of items.filter((item) => item.txHash)) {
        const key = `${withdrawal.assetCode}:${withdrawal.network}:${status}`;
        const current = totals.get(key) ?? {
          assetCode: withdrawal.assetCode,
          network: withdrawal.network,
          status,
          amount: "0",
          fee: "0",
          count: 0
        };
        current.amount = addAmounts(current.amount, withdrawal.amount);
        current.fee = addAmounts(current.fee, withdrawal.fee);
        current.count += 1;
        totals.set(key, current);
      }
    }
    return [...totals.values()];
  }

  async saveProofOfReservesSnapshot(snapshot: ProofOfReservesSnapshot, leaves: ProofOfReservesLeaf[]): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
    for (const leaf of leaves) {
      this.leaves.set(`${leaf.snapshotId}:${leaf.userId}`, structuredClone(leaf));
    }
  }

  async findLatestProofOfReservesSnapshot(): Promise<ProofOfReservesSnapshot | null> {
    const [latest] = await this.listProofOfReservesSnapshots(1);
    return latest ?? null;
  }

  async findProofOfReservesSnapshot(snapshotId: string): Promise<ProofOfReservesSnapshot | null> {
    const snapshot = this.snapshots.find((item) => item.snapshotId === snapshotId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async listProofOfReservesSnapshots(limit: number): Promise<ProofOfReservesSnapshot[]> {
    return [...this.snapshots]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async findProofOfReservesLeaf(snapshotId: string, userId: string): Promise<ProofOfReservesLeaf | null> {
    const leaf = this.leaves.get(`${snapshotId}:${userId}`);
    return leaf ? structuredClone(leaf) : null;
  }
}
