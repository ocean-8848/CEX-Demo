import { fromAtomicUnits, toAtomicUnits } from "@web3-cex/domain";
import type { AssetCode, Network } from "@web3-cex/domain";
import type { Pool, PoolClient } from "pg";

import type { TreasuryRepository } from "../domain/treasury-repository.js";
import type {
  AssetNetworkAmount,
  ListTreasuryTransfersQuery,
  ProofOfReservesAsset,
  ProofOfReservesLeaf,
  ProofOfReservesSnapshot,
  ProofStep,
  SentWithdrawalTotal,
  TreasuryTransferEvent,
  TreasuryTransferRecord,
  TreasuryTransferTotal,
  UnsweptDeposit
} from "../domain/treasury-types.js";
import type { PagedResult } from "../domain/types.js";
import { withPgTransaction } from "./postgres.js";

interface TransferRow {
  transfer_id: string;
  kind: TreasuryTransferRecord["kind"];
  status: TreasuryTransferRecord["status"];
  trigger: TreasuryTransferRecord["trigger"];
  asset_code: AssetCode;
  network: Network;
  amount: string;
  from_wallet: TreasuryTransferRecord["fromWallet"];
  to_wallet: TreasuryTransferRecord["toWallet"];
  from_address: string | null;
  to_address: string;
  idempotency_key: string;
  reason: string | null;
  requested_by: string;
  reviewed_by: string | null;
  review_note: string | null;
  custody_transfer_id: string | null;
  provider_name: string | null;
  tx_hash: string | null;
  confirmations: number;
  block_number: string | number | null;
  last_error: string | null;
  events: TreasuryTransferEvent[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  approved_at: Date | null;
  broadcasted_at: Date | null;
  confirmed_at: Date | null;
  rejected_at: Date | null;
  failed_at: Date | null;
}

interface SnapshotRow {
  snapshot_id: string;
  merkle_root: string;
  leaf_count: number;
  tree_depth: number;
  assets: ProofOfReservesAsset[];
  generated_by: string;
  created_at: Date;
}

interface LeafRow {
  snapshot_id: string;
  user_id: string;
  leaf_index: number;
  nonce: string;
  user_hash: string;
  balances: Record<AssetCode, string>;
  leaf_hash: string;
  proof: ProofStep[];
}

const TRANSFER_COLUMNS = `transfer_id, kind, status, trigger, asset_code, network, amount::text as amount,
  from_wallet, to_wallet, from_address, to_address, idempotency_key, reason, requested_by,
  reviewed_by, review_note, custody_transfer_id, provider_name, tx_hash, confirmations,
  block_number, last_error, events, metadata, created_at, updated_at, approved_at,
  broadcasted_at, confirmed_at, rejected_at, failed_at`;

export class PostgresTreasuryRepository implements TreasuryRepository {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly transactionOwner?: Pool
  ) {}

  async withTransaction<T>(operation: (repository: TreasuryRepository) => Promise<T>): Promise<T> {
    if (!this.transactionOwner) {
      return operation(this);
    }
    return withPgTransaction(this.transactionOwner, async (client) =>
      operation(new PostgresTreasuryRepository(client))
    );
  }

  async insertTransfer(record: TreasuryTransferRecord): Promise<void> {
    await this.db.query(
      `insert into treasury_transfers (
         transfer_id, kind, status, trigger, asset_code, network, amount, from_wallet, to_wallet,
         from_address, to_address, idempotency_key, reason, requested_by, reviewed_by, review_note,
         custody_transfer_id, provider_name, tx_hash, confirmations, block_number, last_error,
         events, metadata, created_at, updated_at, approved_at, broadcasted_at, confirmed_at,
         rejected_at, failed_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22, $23::jsonb, $24::jsonb, $25, $26, $27, $28, $29, $30, $31
       )`,
      transferValues(record)
    );
  }

  async updateTransfer(record: TreasuryTransferRecord): Promise<void> {
    await this.db.query(
      `update treasury_transfers set
         kind = $2, status = $3, trigger = $4, asset_code = $5, network = $6, amount = $7,
         from_wallet = $8, to_wallet = $9, from_address = $10, to_address = $11,
         idempotency_key = $12, reason = $13, requested_by = $14, reviewed_by = $15,
         review_note = $16, custody_transfer_id = $17, provider_name = $18, tx_hash = $19,
         confirmations = $20, block_number = $21, last_error = $22, events = $23::jsonb,
         metadata = $24::jsonb, created_at = $25, updated_at = $26, approved_at = $27,
         broadcasted_at = $28, confirmed_at = $29, rejected_at = $30, failed_at = $31
       where transfer_id = $1`,
      transferValues(record)
    );
  }

  async findTransferById(transferId: string): Promise<TreasuryTransferRecord | null> {
    const result = await this.db.query<TransferRow>(
      `select ${TRANSFER_COLUMNS} from treasury_transfers where transfer_id = $1`,
      [transferId]
    );
    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async findTransferByIdempotencyKey(idempotencyKey: string): Promise<TreasuryTransferRecord | null> {
    const result = await this.db.query<TransferRow>(
      `select ${TRANSFER_COLUMNS} from treasury_transfers where idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async findTransferByTxHash(network: Network, txHash: string): Promise<TreasuryTransferRecord | null> {
    const result = await this.db.query<TransferRow>(
      `select ${TRANSFER_COLUMNS} from treasury_transfers
       where network = $1 and tx_hash = $2
       order by created_at desc
       limit 1`,
      [network, txHash]
    );
    return result.rows[0] ? mapTransfer(result.rows[0]) : null;
  }

  async listTransfers(query: ListTreasuryTransfersQuery): Promise<PagedResult<TreasuryTransferRecord>> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const statuses = query.statuses?.length ? query.statuses : query.status ? [query.status] : null;
    const values = [
      query.kind ?? null,
      statuses,
      query.assetCode ?? null,
      query.network ?? null,
      query.txHash ?? null
    ];
    const where = `where ($1::text is null or kind = $1)
         and ($2::text[] is null or status = any($2::text[]))
         and ($3::text is null or asset_code = $3)
         and ($4::text is null or network = $4)
         and ($5::text is null or tx_hash = $5)`;
    const [rows, count] = await Promise.all([
      this.db.query<TransferRow>(
        `select ${TRANSFER_COLUMNS} from treasury_transfers ${where}
         order by created_at desc
         limit $6 offset $7`,
        [...values, limit, offset]
      ),
      this.db.query<{ total: string }>(`select count(*)::text as total from treasury_transfers ${where}`, values)
    ]);
    return {
      items: rows.rows.map(mapTransfer),
      total: Number(count.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async listTransferTotals(): Promise<TreasuryTransferTotal[]> {
    const result = await this.db.query<{
      kind: TreasuryTransferTotal["kind"];
      from_wallet: TreasuryTransferTotal["fromWallet"];
      to_wallet: TreasuryTransferTotal["toWallet"];
      asset_code: AssetCode;
      network: Network;
      status: TreasuryTransferTotal["status"];
      amount: string;
      count: string;
    }>(
      `select kind, from_wallet, to_wallet, asset_code, network, status,
              sum(amount)::text as amount, count(*)::text as count
       from treasury_transfers
       group by kind, from_wallet, to_wallet, asset_code, network, status`
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      fromWallet: row.from_wallet,
      toWallet: row.to_wallet,
      assetCode: row.asset_code,
      network: row.network,
      status: row.status,
      amount: row.amount,
      count: Number(row.count)
    }));
  }

  async listUnsweptCreditedDeposits(limit: number): Promise<UnsweptDeposit[]> {
    const result = await this.db.query<{
      deposit_id: string;
      user_id: string;
      asset_code: AssetCode;
      network: Network;
      address: string;
      amount: string;
      credited_at: Date | null;
    }>(
      `select d.deposit_id, d.user_id, d.asset_code, d.network, d.address,
              d.amount::text as amount, d.credited_at
       from deposits d
       left join treasury_sweep_deposits s on s.deposit_id = d.deposit_id
       where d.status = 'credited' and s.deposit_id is null
       order by d.credited_at asc nulls last, d.deposit_id
       limit $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      depositId: row.deposit_id,
      userId: row.user_id,
      assetCode: row.asset_code,
      network: row.network,
      address: row.address,
      amount: row.amount,
      creditedAt: row.credited_at?.toISOString()
    }));
  }

  async linkSweepDeposits(transferId: string, depositIds: string[], now: string): Promise<void> {
    if (depositIds.length === 0) {
      return;
    }
    await this.db.query(
      `insert into treasury_sweep_deposits (deposit_id, transfer_id, created_at)
       select unnest($1::uuid[]), $2::uuid, $3::timestamptz`,
      [depositIds, transferId, now]
    );
  }

  async unlinkSweepDeposits(transferId: string): Promise<void> {
    await this.db.query(`delete from treasury_sweep_deposits where transfer_id = $1`, [transferId]);
  }

  async listSweepDepositIds(transferId: string): Promise<string[]> {
    const result = await this.db.query<{ deposit_id: string }>(
      `select deposit_id from treasury_sweep_deposits where transfer_id = $1 order by deposit_id`,
      [transferId]
    );
    return result.rows.map((row) => row.deposit_id);
  }

  async sumCreditedDeposits(): Promise<AssetNetworkAmount[]> {
    const result = await this.db.query<{ asset_code: AssetCode; network: Network; amount: string; count: string }>(
      `select asset_code, network, sum(amount)::text as amount, count(*)::text as count
       from deposits
       where status = 'credited'
       group by asset_code, network`
    );
    return result.rows.map((row) => ({
      assetCode: row.asset_code,
      network: row.network,
      amount: row.amount,
      count: Number(row.count)
    }));
  }

  async sumSentWithdrawals(): Promise<SentWithdrawalTotal[]> {
    const result = await this.db.query<{
      asset_code: AssetCode;
      network: Network;
      status: SentWithdrawalTotal["status"];
      amount: string;
      fee: string;
      count: string;
    }>(
      `select asset_code, network, status, sum(amount)::text as amount,
              sum(fee)::text as fee, count(*)::text as count
       from withdrawals
       where status in ('broadcasted', 'confirmed') and tx_hash is not null
       group by asset_code, network, status`
    );
    return result.rows.map((row) => ({
      assetCode: row.asset_code,
      network: row.network,
      status: row.status,
      amount: row.amount,
      fee: row.fee,
      count: Number(row.count)
    }));
  }

  async saveProofOfReservesSnapshot(snapshot: ProofOfReservesSnapshot, leaves: ProofOfReservesLeaf[]): Promise<void> {
    await this.db.query(
      `insert into proof_of_reserves_snapshots (
         snapshot_id, merkle_root, leaf_count, tree_depth, assets, generated_by, created_at
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        snapshot.snapshotId,
        snapshot.merkleRoot,
        snapshot.leafCount,
        snapshot.treeDepth,
        JSON.stringify(snapshot.assets),
        snapshot.generatedBy,
        snapshot.createdAt
      ]
    );
    const chunkSize = 200;
    for (let start = 0; start < leaves.length; start += chunkSize) {
      const chunk = leaves.slice(start, start + chunkSize);
      const values: unknown[] = [];
      const tuples = chunk.map((leaf, index) => {
        const base = index * 8;
        values.push(
          leaf.snapshotId,
          leaf.userId,
          leaf.leafIndex,
          leaf.nonce,
          leaf.userHash,
          JSON.stringify(leaf.balances),
          leaf.leafHash,
          JSON.stringify(leaf.proof)
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}, $${base + 8}::jsonb)`;
      });
      await this.db.query(
        `insert into proof_of_reserves_leaves (
           snapshot_id, user_id, leaf_index, nonce, user_hash, balances, leaf_hash, proof
         ) values ${tuples.join(", ")}`,
        values
      );
    }
  }

  async findLatestProofOfReservesSnapshot(): Promise<ProofOfReservesSnapshot | null> {
    const [latest] = await this.listProofOfReservesSnapshots(1);
    return latest ?? null;
  }

  async findProofOfReservesSnapshot(snapshotId: string): Promise<ProofOfReservesSnapshot | null> {
    const result = await this.db.query<SnapshotRow>(
      `select * from proof_of_reserves_snapshots where snapshot_id = $1`,
      [snapshotId]
    );
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null;
  }

  async listProofOfReservesSnapshots(limit: number): Promise<ProofOfReservesSnapshot[]> {
    const result = await this.db.query<SnapshotRow>(
      `select * from proof_of_reserves_snapshots order by created_at desc limit $1`,
      [Math.min(Math.max(limit, 1), 100)]
    );
    return result.rows.map(mapSnapshot);
  }

  async findProofOfReservesLeaf(snapshotId: string, userId: string): Promise<ProofOfReservesLeaf | null> {
    const result = await this.db.query<LeafRow>(
      `select * from proof_of_reserves_leaves where snapshot_id = $1 and user_id = $2`,
      [snapshotId, userId]
    );
    const row = result.rows[0];
    return row
      ? {
          snapshotId: row.snapshot_id,
          userId: row.user_id,
          leafIndex: row.leaf_index,
          nonce: row.nonce,
          userHash: row.user_hash,
          balances: row.balances,
          leafHash: row.leaf_hash,
          proof: row.proof
        }
      : null;
  }
}

function transferValues(record: TreasuryTransferRecord): unknown[] {
  return [
    record.transferId,
    record.kind,
    record.status,
    record.trigger,
    record.assetCode,
    record.network,
    record.amount,
    record.fromWallet,
    record.toWallet,
    record.fromAddress ?? null,
    record.toAddress,
    record.idempotencyKey,
    record.reason ?? null,
    record.requestedBy,
    record.reviewedBy ?? null,
    record.reviewNote ?? null,
    record.custodyTransferId ?? null,
    record.providerName ?? null,
    record.txHash ?? null,
    record.confirmations,
    record.blockNumber ?? null,
    record.lastError ?? null,
    JSON.stringify(record.events),
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
    record.approvedAt ?? null,
    record.broadcastedAt ?? null,
    record.confirmedAt ?? null,
    record.rejectedAt ?? null,
    record.failedAt ?? null
  ];
}

function mapTransfer(row: TransferRow): TreasuryTransferRecord {
  return {
    transferId: row.transfer_id,
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    assetCode: row.asset_code,
    network: row.network,
    amount: fromAtomicUnits(toAtomicUnits(row.amount)),
    fromWallet: row.from_wallet,
    toWallet: row.to_wallet,
    fromAddress: row.from_address ?? undefined,
    toAddress: row.to_address,
    idempotencyKey: row.idempotency_key,
    reason: row.reason ?? undefined,
    requestedBy: row.requested_by,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewNote: row.review_note ?? undefined,
    custodyTransferId: row.custody_transfer_id ?? undefined,
    providerName: row.provider_name ?? undefined,
    txHash: row.tx_hash ?? undefined,
    confirmations: Number(row.confirmations ?? 0),
    blockNumber: row.block_number === null ? undefined : Number(row.block_number),
    lastError: row.last_error ?? undefined,
    events: Array.isArray(row.events) ? row.events : [],
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    approvedAt: row.approved_at?.toISOString(),
    broadcastedAt: row.broadcasted_at?.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString(),
    rejectedAt: row.rejected_at?.toISOString(),
    failedAt: row.failed_at?.toISOString()
  };
}

function mapSnapshot(row: SnapshotRow): ProofOfReservesSnapshot {
  return {
    snapshotId: row.snapshot_id,
    merkleRoot: row.merkle_root,
    leafCount: row.leaf_count,
    treeDepth: row.tree_depth,
    assets: Array.isArray(row.assets) ? row.assets : [],
    generatedBy: row.generated_by,
    createdAt: row.created_at.toISOString()
  };
}
