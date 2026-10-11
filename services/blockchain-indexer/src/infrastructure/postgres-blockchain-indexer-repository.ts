import type { Network } from "@web3-cex/domain";
import type { Pool, PoolClient } from "pg";

import type { BlockchainIndexerRepository } from "../domain/repository.js";
import type {
  IndexedDepositObservation,
  IndexedWithdrawalObservation,
  ListDepositObservationsQuery,
  ObservationType,
  PagedResult,
  ScanCursor
} from "../domain/types.js";
import { withPgTransaction } from "./postgres.js";

interface DepositObservationRow {
  observation_id: string;
  network: Network;
  asset_code: IndexedDepositObservation["assetCode"];
  address: string;
  tx_hash: string;
  amount: string;
  confirmations: number;
  block_number: string | number | null;
  block_hash: string | null;
  status: IndexedDepositObservation["status"];
  wallet_deposit_id: string | null;
  reorg_detected_at: Date | null;
  reorged_from_block_number: string | number | null;
  last_manual_action: IndexedDepositObservation["lastManualAction"] | null;
  last_manual_action_at: Date | null;
  last_manual_action_by: string | null;
  last_manual_action_note: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DepositObservationCountRow {
  total: string;
}

interface WithdrawalObservationRow {
  observation_id: string;
  network: Network;
  asset_code: IndexedWithdrawalObservation["assetCode"];
  tx_hash: string;
  confirmations: number;
  block_number: string | number | null;
  block_hash: string | null;
  status: IndexedWithdrawalObservation["status"];
  wallet_withdrawal_id: string | null;
  reorg_detected_at: Date | null;
  reorged_from_block_number: string | number | null;
  created_at: Date;
  updated_at: Date;
}

interface ScanCursorRow {
  cursor_id: string;
  observation_type: ObservationType;
  network: Network;
  last_scanned_block: string | number | null;
  last_finalized_block: string | number | null;
  reorg_detected_at: Date | null;
  reorg_detected_block: string | number | null;
  updated_at: Date;
}

export class PostgresBlockchainIndexerRepository implements BlockchainIndexerRepository {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly transactionOwner?: Pool
  ) {}

  async withTransaction<T>(
    operation: (repository: BlockchainIndexerRepository) => Promise<T>
  ): Promise<T> {
    if (!this.transactionOwner) {
      return operation(this);
    }

    return withPgTransaction(this.transactionOwner, async (client) =>
      operation(new PostgresBlockchainIndexerRepository(client))
    );
  }

  async upsertDepositObservation(observation: IndexedDepositObservation): Promise<void> {
    await this.db.query(
      `insert into blockchain_deposit_observations
       (observation_id, network, asset_code, address, tx_hash, amount, confirmations, block_number, block_hash,
        status, wallet_deposit_id, reorg_detected_at, reorged_from_block_number, last_manual_action,
        last_manual_action_at, last_manual_action_by, last_manual_action_note, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       on conflict (network, tx_hash, address) do update
       set asset_code = excluded.asset_code,
           amount = excluded.amount,
           confirmations = excluded.confirmations,
           block_number = excluded.block_number,
           block_hash = excluded.block_hash,
           status = excluded.status,
           wallet_deposit_id = excluded.wallet_deposit_id,
           reorg_detected_at = excluded.reorg_detected_at,
           reorged_from_block_number = excluded.reorged_from_block_number,
           last_manual_action = excluded.last_manual_action,
           last_manual_action_at = excluded.last_manual_action_at,
           last_manual_action_by = excluded.last_manual_action_by,
           last_manual_action_note = excluded.last_manual_action_note,
           updated_at = excluded.updated_at`,
      [
        observation.observationId,
        observation.network,
        observation.assetCode,
        observation.address,
        observation.txHash,
        observation.amount,
        observation.confirmations,
        observation.blockNumber ?? null,
        observation.blockHash ?? null,
        observation.status,
        observation.walletDepositId ?? null,
        observation.reorgDetectedAt ?? null,
        observation.reorgedFromBlockNumber ?? null,
        observation.lastManualAction ?? null,
        observation.lastManualActionAt ?? null,
        observation.lastManualActionBy ?? null,
        observation.lastManualActionNote ?? null,
        observation.createdAt,
        observation.updatedAt
      ]
    );
  }

  async findDepositObservationByUniqueKey(
    network: Network,
    txHash: string,
    address: string
  ): Promise<IndexedDepositObservation | null> {
    const result = await this.db.query<DepositObservationRow>(
      `select observation_id, network, asset_code, address, tx_hash, amount::text as amount,
              confirmations, block_number, block_hash, status, wallet_deposit_id, reorg_detected_at,
              reorged_from_block_number, last_manual_action, last_manual_action_at,
              last_manual_action_by, last_manual_action_note, created_at, updated_at
       from blockchain_deposit_observations
       where network = $1 and tx_hash = $2 and address = $3`,
      [network, txHash, address]
    );

    return result.rows[0] ? mapDepositObservation(result.rows[0]) : null;
  }

  async findDepositObservationById(
    observationId: string
  ): Promise<IndexedDepositObservation | null> {
    const result = await this.db.query<DepositObservationRow>(
      `select observation_id, network, asset_code, address, tx_hash, amount::text as amount,
              confirmations, block_number, block_hash, status, wallet_deposit_id, reorg_detected_at,
              reorged_from_block_number, last_manual_action, last_manual_action_at,
              last_manual_action_by, last_manual_action_note, created_at, updated_at
       from blockchain_deposit_observations
       where observation_id = $1`,
      [observationId]
    );

    return result.rows[0] ? mapDepositObservation(result.rows[0]) : null;
  }

  async listDepositObservations(
    query: ListDepositObservationsQuery
  ): Promise<PagedResult<IndexedDepositObservation>> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.network) {
      values.push(query.network);
      conditions.push(`network = $${values.length}`);
    }

    if (query.assetCode) {
      values.push(query.assetCode);
      conditions.push(`asset_code = $${values.length}`);
    }

    if (query.status === "pending") {
      conditions.push(`status in ('detected', 'confirming')`);
    } else if (query.status) {
      values.push(query.status);
      conditions.push(`status = $${values.length}`);
    }

    if (query.olderThanSeconds !== undefined) {
      values.push(query.olderThanSeconds);
      conditions.push(`created_at <= now() - ($${values.length}::text || ' seconds')::interval`);
    }

    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<DepositObservationRow>(
      `select observation_id, network, asset_code, address, tx_hash, amount::text as amount,
              confirmations, block_number, block_hash, status, wallet_deposit_id, reorg_detected_at,
              reorged_from_block_number, last_manual_action, last_manual_action_at,
              last_manual_action_by, last_manual_action_note, created_at, updated_at
       from blockchain_deposit_observations
       ${whereClause}
       order by created_at asc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const count = await this.db.query<DepositObservationCountRow>(
      `select count(*)::text as total
       from blockchain_deposit_observations
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapDepositObservation),
      total: Number(count.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async listPendingDepositObservations(
    network: Network,
    fromBlock: number,
    toBlock: number
  ): Promise<IndexedDepositObservation[]> {
    const result = await this.db.query<DepositObservationRow>(
      `select observation_id, network, asset_code, address, tx_hash, amount::text as amount,
              confirmations, block_number, block_hash, status, wallet_deposit_id, reorg_detected_at,
              reorged_from_block_number, last_manual_action, last_manual_action_at,
              last_manual_action_by, last_manual_action_note, created_at, updated_at
       from blockchain_deposit_observations
       where network = $1
         and status in ('detected', 'confirming')
         and block_number is not null
         and block_number >= $2
         and block_number <= $3`,
      [network, fromBlock, toBlock]
    );

    return result.rows.map(mapDepositObservation);
  }

  async deleteDepositObservations(observationIds: string[]): Promise<void> {
    if (observationIds.length === 0) {
      return;
    }

    await this.db.query(
      `delete from blockchain_deposit_observations
       where observation_id = any($1::uuid[])`,
      [observationIds]
    );
  }

  async upsertWithdrawalObservation(observation: IndexedWithdrawalObservation): Promise<void> {
    await this.db.query(
      `insert into blockchain_withdrawal_observations
       (observation_id, network, asset_code, tx_hash, confirmations, block_number, block_hash, status,
        wallet_withdrawal_id, reorg_detected_at, reorged_from_block_number, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (network, tx_hash) do update
       set asset_code = excluded.asset_code,
           confirmations = excluded.confirmations,
           block_number = excluded.block_number,
           block_hash = excluded.block_hash,
           status = excluded.status,
           wallet_withdrawal_id = excluded.wallet_withdrawal_id,
           reorg_detected_at = excluded.reorg_detected_at,
           reorged_from_block_number = excluded.reorged_from_block_number,
           updated_at = excluded.updated_at`,
      [
        observation.observationId,
        observation.network,
        observation.assetCode,
        observation.txHash,
        observation.confirmations,
        observation.blockNumber ?? null,
        observation.blockHash ?? null,
        observation.status,
        observation.walletWithdrawalId ?? null,
        observation.reorgDetectedAt ?? null,
        observation.reorgedFromBlockNumber ?? null,
        observation.createdAt,
        observation.updatedAt
      ]
    );
  }

  async findWithdrawalObservationByUniqueKey(
    network: Network,
    txHash: string
  ): Promise<IndexedWithdrawalObservation | null> {
    const result = await this.db.query<WithdrawalObservationRow>(
      `select observation_id, network, asset_code, tx_hash, confirmations, block_number, status,
              block_hash, wallet_withdrawal_id, reorg_detected_at, reorged_from_block_number, created_at, updated_at
       from blockchain_withdrawal_observations
       where network = $1 and tx_hash = $2`,
      [network, txHash]
    );

    return result.rows[0] ? mapWithdrawalObservation(result.rows[0]) : null;
  }

  async findWithdrawalObservationById(
    observationId: string
  ): Promise<IndexedWithdrawalObservation | null> {
    const result = await this.db.query<WithdrawalObservationRow>(
      `select observation_id, network, asset_code, tx_hash, confirmations, block_number, status,
              block_hash, wallet_withdrawal_id, reorg_detected_at, reorged_from_block_number, created_at, updated_at
       from blockchain_withdrawal_observations
       where observation_id = $1`,
      [observationId]
    );

    return result.rows[0] ? mapWithdrawalObservation(result.rows[0]) : null;
  }

  async listPendingWithdrawalObservations(
    network: Network
  ): Promise<IndexedWithdrawalObservation[]> {
    const result = await this.db.query<WithdrawalObservationRow>(
      `select observation_id, network, asset_code, tx_hash, confirmations, block_number, block_hash, status,
              wallet_withdrawal_id, reorg_detected_at, reorged_from_block_number, created_at, updated_at
       from blockchain_withdrawal_observations
       where network = $1
         and status != 'confirmed'`,
      [network]
    );

    return result.rows.map(mapWithdrawalObservation);
  }

  async deleteWithdrawalObservations(observationIds: string[]): Promise<void> {
    if (observationIds.length === 0) {
      return;
    }

    await this.db.query(
      `delete from blockchain_withdrawal_observations
       where observation_id = any($1::uuid[])`,
      [observationIds]
    );
  }

  async saveScanCursor(cursor: ScanCursor): Promise<void> {
    await this.db.query(
      `insert into blockchain_scan_cursors
       (cursor_id, observation_type, network, last_scanned_block, last_finalized_block,
        reorg_detected_at, reorg_detected_block, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (observation_type, network) do update
       set last_scanned_block = excluded.last_scanned_block,
           last_finalized_block = excluded.last_finalized_block,
           reorg_detected_at = excluded.reorg_detected_at,
           reorg_detected_block = excluded.reorg_detected_block,
           updated_at = excluded.updated_at`,
      [
        cursor.cursorId,
        cursor.observationType,
        cursor.network,
        cursor.lastScannedBlock ?? null,
        cursor.lastFinalizedBlock ?? null,
        cursor.reorgDetectedAt ?? null,
        cursor.reorgDetectedBlock ?? null,
        cursor.updatedAt
      ]
    );
  }

  async findScanCursor(
    observationType: ObservationType,
    network: Network
  ): Promise<ScanCursor | null> {
    const result = await this.db.query<ScanCursorRow>(
      `select cursor_id, observation_type, network, last_scanned_block, last_finalized_block,
              reorg_detected_at, reorg_detected_block, updated_at
       from blockchain_scan_cursors
       where observation_type = $1 and network = $2`,
      [observationType, network]
    );

    return result.rows[0] ? mapScanCursor(result.rows[0]) : null;
  }
}

function mapDepositObservation(row: DepositObservationRow): IndexedDepositObservation {
  return {
    observationId: row.observation_id,
    network: row.network,
    assetCode: row.asset_code,
    address: row.address,
    txHash: row.tx_hash,
    amount: row.amount,
    confirmations: row.confirmations,
    blockNumber: parseOptionalBigInt(row.block_number),
    blockHash: row.block_hash ?? undefined,
    status: row.status,
    walletDepositId: row.wallet_deposit_id ?? undefined,
    reorgDetectedAt: row.reorg_detected_at?.toISOString(),
    reorgedFromBlockNumber: parseOptionalBigInt(row.reorged_from_block_number),
    lastManualAction: row.last_manual_action ?? undefined,
    lastManualActionAt: row.last_manual_action_at?.toISOString(),
    lastManualActionBy: row.last_manual_action_by ?? undefined,
    lastManualActionNote: row.last_manual_action_note ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapWithdrawalObservation(
  row: WithdrawalObservationRow
): IndexedWithdrawalObservation {
  return {
    observationId: row.observation_id,
    network: row.network,
    assetCode: row.asset_code,
    txHash: row.tx_hash,
    confirmations: row.confirmations,
    blockNumber: parseOptionalBigInt(row.block_number),
    blockHash: row.block_hash ?? undefined,
    status: row.status,
    walletWithdrawalId: row.wallet_withdrawal_id ?? undefined,
    reorgDetectedAt: row.reorg_detected_at?.toISOString(),
    reorgedFromBlockNumber: parseOptionalBigInt(row.reorged_from_block_number),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapScanCursor(row: ScanCursorRow): ScanCursor {
  return {
    cursorId: row.cursor_id,
    observationType: row.observation_type,
    network: row.network,
    lastScannedBlock: parseOptionalBigInt(row.last_scanned_block),
    lastFinalizedBlock: parseOptionalBigInt(row.last_finalized_block),
    reorgDetectedAt: row.reorg_detected_at?.toISOString(),
    reorgDetectedBlock: parseOptionalBigInt(row.reorg_detected_block),
    updatedAt: row.updated_at.toISOString()
  };
}

function parseOptionalBigInt(value: string | number | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  return typeof value === "number" ? value : Number(value);
}
