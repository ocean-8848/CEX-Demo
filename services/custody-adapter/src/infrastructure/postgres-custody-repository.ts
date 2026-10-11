import type { Pool, PoolClient } from "pg";

import type { CustodyRepository } from "../domain/repository.js";
import type {
  CustodyTransferAttemptRecord,
  CustodyTransferRecord
} from "../domain/types.js";
import { withPgTransaction } from "./postgres.js";

interface CustodyTransferRow {
  custody_transfer_id: string;
  reference_id: string;
  asset_code: CustodyTransferRecord["assetCode"];
  network: CustodyTransferRecord["network"];
  to_address: string;
  amount: string;
  fee: string;
  idempotency_key: string;
  provider_name: string;
  provider_transfer_id: string | null;
  status: CustodyTransferRecord["status"];
  tx_hash: string | null;
  attempt_count: number;
  next_retry_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  broadcasted_at: Date | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
  last_synced_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface CustodyTransferAttemptRow {
  attempt_id: string;
  custody_transfer_id: string;
  attempt_number: number;
  action: CustodyTransferAttemptRecord["action"];
  status: CustodyTransferAttemptRecord["status"];
  provider_name: string;
  tx_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  created_at: Date;
}

export class PostgresCustodyRepository implements CustodyRepository {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly transactionOwner?: Pool
  ) {}

  async withTransaction<T>(operation: (repository: CustodyRepository) => Promise<T>): Promise<T> {
    if (!this.transactionOwner) {
      return operation(this);
    }

    return withPgTransaction(this.transactionOwner, async (client) =>
      operation(new PostgresCustodyRepository(client))
    );
  }

  async saveTransfer(record: CustodyTransferRecord): Promise<void> {
    await this.db.query(
      `insert into custody_transfers
       (custody_transfer_id, reference_id, asset_code, network, to_address, amount, fee, idempotency_key,
        provider_name, provider_transfer_id, status, tx_hash, attempt_count, next_retry_at, last_error_code,
        last_error_message, broadcasted_at, confirmed_at, failed_at, last_synced_at, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21::jsonb, $22, $23)
       on conflict (idempotency_key) do update
       set reference_id = excluded.reference_id,
           asset_code = excluded.asset_code,
           network = excluded.network,
           to_address = excluded.to_address,
           amount = excluded.amount,
           fee = excluded.fee,
           provider_name = excluded.provider_name,
           provider_transfer_id = excluded.provider_transfer_id,
           status = excluded.status,
           tx_hash = excluded.tx_hash,
           attempt_count = excluded.attempt_count,
           next_retry_at = excluded.next_retry_at,
           last_error_code = excluded.last_error_code,
           last_error_message = excluded.last_error_message,
           broadcasted_at = excluded.broadcasted_at,
           confirmed_at = excluded.confirmed_at,
           failed_at = excluded.failed_at,
           last_synced_at = excluded.last_synced_at,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`,
      [
        record.custodyTransferId,
        record.referenceId,
        record.assetCode,
        record.network,
        record.toAddress,
        record.amount,
        record.fee,
        record.idempotencyKey,
        record.providerName,
        record.providerTransferId ?? null,
        record.status,
        record.txHash ?? null,
        record.attemptCount,
        record.nextRetryAt ?? null,
        record.lastErrorCode ?? null,
        record.lastErrorMessage ?? null,
        record.broadcastedAt ?? null,
        record.confirmedAt ?? null,
        record.failedAt ?? null,
        record.lastSyncedAt ?? null,
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  async saveTransferAttempt(record: CustodyTransferAttemptRecord): Promise<void> {
    await this.db.query(
      `insert into custody_transfer_attempts
       (attempt_id, custody_transfer_id, attempt_number, action, status, provider_name, tx_hash,
        error_code, error_message, request_payload, response_payload, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)`,
      [
        record.attemptId,
        record.custodyTransferId,
        record.attemptNumber,
        record.action,
        record.status,
        record.providerName,
        record.txHash ?? null,
        record.errorCode ?? null,
        record.errorMessage ?? null,
        JSON.stringify(record.requestPayload),
        JSON.stringify(record.responsePayload),
        record.createdAt
      ]
    );
  }

  async findTransferById(custodyTransferId: string): Promise<CustodyTransferRecord | null> {
    const result = await this.db.query<CustodyTransferRow>(
      `select custody_transfer_id, reference_id, asset_code, network, to_address, amount::text as amount,
              fee::text as fee, idempotency_key, provider_name, provider_transfer_id, status, tx_hash,
              attempt_count, next_retry_at, last_error_code, last_error_message, broadcasted_at, confirmed_at,
              failed_at, last_synced_at, metadata, created_at, updated_at
       from custody_transfers
       where custody_transfer_id = $1`,
      [custodyTransferId]
    );

    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async findTransferByIdempotencyKey(idempotencyKey: string): Promise<CustodyTransferRecord | null> {
    const result = await this.db.query<CustodyTransferRow>(
      `select custody_transfer_id, reference_id, asset_code, network, to_address, amount::text as amount,
              fee::text as fee, idempotency_key, provider_name, provider_transfer_id, status, tx_hash,
              attempt_count, next_retry_at, last_error_code, last_error_message, broadcasted_at, confirmed_at,
              failed_at, last_synced_at, metadata, created_at, updated_at
       from custody_transfers
       where idempotency_key = $1`,
      [idempotencyKey]
    );

    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async listTransfersNeedingStatusSync(
    limit: number,
    syncedBefore: string
  ): Promise<CustodyTransferRecord[]> {
    const result = await this.db.query<CustodyTransferRow>(
      `select custody_transfer_id, reference_id, asset_code, network, to_address, amount::text as amount,
              fee::text as fee, idempotency_key, provider_name, provider_transfer_id, status, tx_hash,
              attempt_count, next_retry_at, last_error_code, last_error_message, broadcasted_at, confirmed_at,
              failed_at, last_synced_at, metadata, created_at, updated_at
       from custody_transfers
       where status in ('accepted', 'broadcasted')
         and (last_synced_at is null or last_synced_at <= $2)
       order by coalesce(last_synced_at, created_at) asc, created_at asc
       limit $1`,
      [limit, syncedBefore]
    );

    return result.rows.map(mapTransfer);
  }

  async listRetryableTransfers(limit: number, now: string): Promise<CustodyTransferRecord[]> {
    const result = await this.db.query<CustodyTransferRow>(
      `select custody_transfer_id, reference_id, asset_code, network, to_address, amount::text as amount,
              fee::text as fee, idempotency_key, provider_name, provider_transfer_id, status, tx_hash,
              attempt_count, next_retry_at, last_error_code, last_error_message, broadcasted_at, confirmed_at,
              failed_at, last_synced_at, metadata, created_at, updated_at
       from custody_transfers
       where status = 'failed'
         and next_retry_at is not null
         and next_retry_at <= $2
       order by next_retry_at asc, created_at asc
       limit $1`,
      [limit, now]
    );

    return result.rows.map(mapTransfer);
  }

  async listTransferAttempts(custodyTransferId: string): Promise<CustodyTransferAttemptRecord[]> {
    const result = await this.db.query<CustodyTransferAttemptRow>(
      `select attempt_id, custody_transfer_id, attempt_number, action, status, provider_name, tx_hash,
              error_code, error_message, request_payload, response_payload, created_at
       from custody_transfer_attempts
       where custody_transfer_id = $1
       order by attempt_number asc, created_at asc`,
      [custodyTransferId]
    );

    return result.rows.map(mapTransferAttempt);
  }
}

function mapTransfer(row: CustodyTransferRow): CustodyTransferRecord {
  return {
    custodyTransferId: row.custody_transfer_id,
    referenceId: row.reference_id,
    assetCode: row.asset_code,
    network: row.network,
    toAddress: row.to_address,
    amount: row.amount,
    fee: row.fee,
    idempotencyKey: row.idempotency_key,
    providerName: row.provider_name,
    providerTransferId: row.provider_transfer_id ?? undefined,
    status: row.status,
    txHash: row.tx_hash ?? undefined,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at?.toISOString(),
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    broadcastedAt: row.broadcasted_at?.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString(),
    failedAt: row.failed_at?.toISOString(),
    lastSyncedAt: row.last_synced_at?.toISOString(),
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapTransferAttempt(row: CustodyTransferAttemptRow): CustodyTransferAttemptRecord {
  return {
    attemptId: row.attempt_id,
    custodyTransferId: row.custody_transfer_id,
    attemptNumber: row.attempt_number,
    action: row.action,
    status: row.status,
    providerName: row.provider_name,
    txHash: row.tx_hash ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    requestPayload: row.request_payload,
    responsePayload: row.response_payload,
    createdAt: row.created_at.toISOString()
  };
}
