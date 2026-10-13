import type { Network } from "@web3-cex/domain";

import type { PagedResult } from "./types.js";
import type {
  AssetNetworkAmount,
  ListTreasuryTransfersQuery,
  ProofOfReservesLeaf,
  ProofOfReservesSnapshot,
  SentWithdrawalTotal,
  TreasuryTransferRecord,
  TreasuryTransferTotal,
  UnsweptDeposit
} from "./treasury-types.js";

export interface TreasuryRepository {
  withTransaction<T>(operation: (repository: TreasuryRepository) => Promise<T>): Promise<T>;

  insertTransfer(record: TreasuryTransferRecord): Promise<void>;
  updateTransfer(record: TreasuryTransferRecord): Promise<void>;
  findTransferById(transferId: string): Promise<TreasuryTransferRecord | null>;
  findTransferByIdempotencyKey(idempotencyKey: string): Promise<TreasuryTransferRecord | null>;
  findTransferByTxHash(network: Network, txHash: string): Promise<TreasuryTransferRecord | null>;
  listTransfers(query: ListTreasuryTransfersQuery): Promise<PagedResult<TreasuryTransferRecord>>;
  listTransferTotals(): Promise<TreasuryTransferTotal[]>;

  /** Credited deposits that are not part of a live sweep yet (oldest first). */
  listUnsweptCreditedDeposits(limit: number): Promise<UnsweptDeposit[]>;
  /** Throws when a deposit is already linked to another sweep. */
  linkSweepDeposits(transferId: string, depositIds: string[], now: string): Promise<void>;
  unlinkSweepDeposits(transferId: string): Promise<void>;
  listSweepDepositIds(transferId: string): Promise<string[]>;

  /** Facts owned by the wallet state machines, read-only for the treasury. */
  sumCreditedDeposits(): Promise<AssetNetworkAmount[]>;
  sumSentWithdrawals(): Promise<SentWithdrawalTotal[]>;

  saveProofOfReservesSnapshot(snapshot: ProofOfReservesSnapshot, leaves: ProofOfReservesLeaf[]): Promise<void>;
  findLatestProofOfReservesSnapshot(): Promise<ProofOfReservesSnapshot | null>;
  findProofOfReservesSnapshot(snapshotId: string): Promise<ProofOfReservesSnapshot | null>;
  listProofOfReservesSnapshots(limit: number): Promise<ProofOfReservesSnapshot[]>;
  findProofOfReservesLeaf(snapshotId: string, userId: string): Promise<ProofOfReservesLeaf | null>;
}
