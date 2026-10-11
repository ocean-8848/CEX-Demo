import type { Network } from "@web3-cex/domain";

import type {
  IndexedDepositObservation,
  IndexedWithdrawalObservation,
  ListDepositObservationsQuery,
  ObservationType,
  PagedResult,
  ScanCursor
} from "./types.js";

export interface BlockchainIndexerRepository {
  withTransaction<T>(
    operation: (repository: BlockchainIndexerRepository) => Promise<T>
  ): Promise<T>;
  upsertDepositObservation(observation: IndexedDepositObservation): Promise<void>;
  findDepositObservationByUniqueKey(
    network: Network,
    txHash: string,
    address: string
  ): Promise<IndexedDepositObservation | null>;
  findDepositObservationById(observationId: string): Promise<IndexedDepositObservation | null>;
  listDepositObservations(
    query: ListDepositObservationsQuery
  ): Promise<PagedResult<IndexedDepositObservation>>;
  listPendingDepositObservations(
    network: Network,
    fromBlock: number,
    toBlock: number
  ): Promise<IndexedDepositObservation[]>;
  deleteDepositObservations(observationIds: string[]): Promise<void>;
  upsertWithdrawalObservation(observation: IndexedWithdrawalObservation): Promise<void>;
  findWithdrawalObservationByUniqueKey(
    network: Network,
    txHash: string
  ): Promise<IndexedWithdrawalObservation | null>;
  findWithdrawalObservationById(
    observationId: string
  ): Promise<IndexedWithdrawalObservation | null>;
  listPendingWithdrawalObservations(network: Network): Promise<IndexedWithdrawalObservation[]>;
  deleteWithdrawalObservations(observationIds: string[]): Promise<void>;
  saveScanCursor(cursor: ScanCursor): Promise<void>;
  findScanCursor(
    observationType: ObservationType,
    network: Network
  ): Promise<ScanCursor | null>;
}
