import type { Network } from "@web3-cex/domain";

import type { BlockchainIndexerRepository } from "../domain/repository.js";
import type {
  IndexedDepositObservation,
  IndexedWithdrawalObservation,
  ListDepositObservationsQuery,
  ObservationType,
  PagedResult,
  ScanCursor
} from "../domain/types.js";

function observationKey(network: Network, txHash: string, address: string): string {
  return `${network}:${txHash}:${address}`;
}

function withdrawalObservationKey(network: Network, txHash: string): string {
  return `${network}:${txHash}`;
}

function cursorKey(observationType: ObservationType, network: Network): string {
  return `${observationType}:${network}`;
}

export class InMemoryBlockchainIndexerRepository implements BlockchainIndexerRepository {
  private readonly depositObservationsById = new Map<string, IndexedDepositObservation>();
  private readonly depositObservationsByKey = new Map<string, IndexedDepositObservation>();
  private readonly withdrawalObservationsById = new Map<string, IndexedWithdrawalObservation>();
  private readonly withdrawalObservationsByKey = new Map<string, IndexedWithdrawalObservation>();
  private readonly cursors = new Map<string, ScanCursor>();

  async withTransaction<T>(
    operation: (repository: BlockchainIndexerRepository) => Promise<T>
  ): Promise<T> {
    return operation(this);
  }

  async upsertDepositObservation(observation: IndexedDepositObservation): Promise<void> {
    this.depositObservationsById.set(observation.observationId, observation);
    this.depositObservationsByKey.set(
      observationKey(observation.network, observation.txHash, observation.address),
      observation
    );
  }

  async findDepositObservationByUniqueKey(
    network: Network,
    txHash: string,
    address: string
  ): Promise<IndexedDepositObservation | null> {
    return this.depositObservationsByKey.get(observationKey(network, txHash, address)) ?? null;
  }

  async findDepositObservationById(observationId: string): Promise<IndexedDepositObservation | null> {
    return this.depositObservationsById.get(observationId) ?? null;
  }

  async listDepositObservations(
    query: ListDepositObservationsQuery
  ): Promise<PagedResult<IndexedDepositObservation>> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const threshold =
      query.olderThanSeconds !== undefined
        ? Date.now() - query.olderThanSeconds * 1000
        : undefined;
    const items = [...this.depositObservationsById.values()]
      .filter((observation) => {
        if (query.network && observation.network !== query.network) {
          return false;
        }

        if (query.assetCode && observation.assetCode !== query.assetCode) {
          return false;
        }

        if (query.status === "pending") {
          if (observation.status !== "detected" && observation.status !== "confirming") {
            return false;
          }
        } else if (query.status && observation.status !== query.status) {
          return false;
        }

        if (
          threshold !== undefined &&
          new Date(observation.createdAt).getTime() > threshold
        ) {
          return false;
        }

        return true;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset
    };
  }

  async listPendingDepositObservations(
    network: Network,
    fromBlock: number,
    toBlock: number
  ): Promise<IndexedDepositObservation[]> {
    return [...this.depositObservationsById.values()].filter((observation) => {
      if (
        observation.network !== network ||
        (observation.status !== "detected" && observation.status !== "confirming")
      ) {
        return false;
      }

      return (
        observation.blockNumber !== undefined &&
        observation.blockNumber >= fromBlock &&
        observation.blockNumber <= toBlock
      );
    });
  }

  async deleteDepositObservations(observationIds: string[]): Promise<void> {
    for (const observationId of observationIds) {
      const observation = this.depositObservationsById.get(observationId);
      if (!observation) {
        continue;
      }

      this.depositObservationsById.delete(observationId);
      this.depositObservationsByKey.delete(
        observationKey(observation.network, observation.txHash, observation.address)
      );
    }
  }

  async upsertWithdrawalObservation(observation: IndexedWithdrawalObservation): Promise<void> {
    this.withdrawalObservationsById.set(observation.observationId, observation);
    this.withdrawalObservationsByKey.set(
      withdrawalObservationKey(observation.network, observation.txHash),
      observation
    );
  }

  async findWithdrawalObservationByUniqueKey(
    network: Network,
    txHash: string
  ): Promise<IndexedWithdrawalObservation | null> {
    return this.withdrawalObservationsByKey.get(withdrawalObservationKey(network, txHash)) ?? null;
  }

  async findWithdrawalObservationById(
    observationId: string
  ): Promise<IndexedWithdrawalObservation | null> {
    return this.withdrawalObservationsById.get(observationId) ?? null;
  }

  async listPendingWithdrawalObservations(
    network: Network
  ): Promise<IndexedWithdrawalObservation[]> {
    return [...this.withdrawalObservationsById.values()].filter(
      (observation) => observation.network === network && observation.status !== "confirmed"
    );
  }

  async deleteWithdrawalObservations(observationIds: string[]): Promise<void> {
    for (const observationId of observationIds) {
      const observation = this.withdrawalObservationsById.get(observationId);
      if (!observation) {
        continue;
      }

      this.withdrawalObservationsById.delete(observationId);
      this.withdrawalObservationsByKey.delete(
        withdrawalObservationKey(observation.network, observation.txHash)
      );
    }
  }

  async saveScanCursor(cursor: ScanCursor): Promise<void> {
    this.cursors.set(cursorKey(cursor.observationType, cursor.network), cursor);
  }

  async findScanCursor(
    observationType: ObservationType,
    network: Network
  ): Promise<ScanCursor | null> {
    return this.cursors.get(cursorKey(observationType, network)) ?? null;
  }
}
