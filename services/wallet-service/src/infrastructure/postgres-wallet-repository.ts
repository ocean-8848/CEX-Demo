import type { AssetCode, Network } from "@web3-cex/domain";
import type { Pool, PoolClient } from "pg";

import type { WalletRepository } from "../domain/repository.js";
import type { AddressBlacklistEntry } from "../domain/withdrawal-risk.js";
import type {
  CreateWithdrawalAddressBookEntryCommand,
  ListAddressBlacklistQuery,
  CreateDepositAddressCommand,
  DepositRecord,
  ListWithdrawalAuditLogsQuery,
  ListDepositAddressesQuery,
  ListWithdrawalAddressBookQuery,
  ListWithdrawalNotificationsQuery,
  ListDepositsQuery,
  ListWithdrawalsQuery,
  PagedResult,
  SetWithdrawalAddressWhitelistStatusCommand,
  UpsertWithdrawalAddressBookEntryCommand,
  WalletNotificationRecord,
  WithdrawalAuditLogRecord,
  WithdrawalRecord,
  WithdrawalAddressBookEntry,
  WalletAddress
} from "../domain/types.js";
import { sumAmounts } from "../domain/money.js";
import { withPgTransaction } from "./postgres.js";

interface WalletAddressRow {
  wallet_address_id: string;
  user_id: string;
  ledger_account_id: string;
  asset_code: AssetCode;
  network: Network;
  address: string;
  status: "active" | "disabled";
  created_at: Date;
}

interface DepositRow {
  deposit_id: string;
  user_id: string;
  ledger_account_id: string;
  ledger_journal_id: string | null;
  asset_code: AssetCode;
  network: Network;
  address: string;
  tx_hash: string;
  amount: string;
  block_number: number | null;
  confirmations: number;
  status: DepositRecord["status"];
  detected_at: Date;
  confirmed_at: Date | null;
  credited_at: Date | null;
  metadata: Record<string, unknown>;
}

interface WithdrawalRow {
  withdrawal_id: string;
  user_id: string;
  ledger_account_id: string | null;
  custody_request_id: string | null;
  asset_code: AssetCode;
  network: Network;
  to_address: string;
  amount: string;
  fee: string;
  frozen_amount: string;
  freeze_reference_id: string | null;
  status: WithdrawalRecord["status"];
  review_status: WithdrawalRecord["reviewStatus"];
  tx_hash: string | null;
  requested_at: Date;
  approved_at: Date | null;
  broadcasted_at: Date | null;
  confirmed_at: Date | null;
  risk_score: number | null;
  risk_level: WithdrawalRecord["riskLevel"] | null;
  risk_reasons: WithdrawalRecord["riskReasons"] | null;
  metadata: Record<string, unknown>;
}

interface AddressBlacklistRow {
  entry_id: string;
  network: Network;
  address: string;
  category: AddressBlacklistEntry["category"];
  reason: string;
  source: AddressBlacklistEntry["source"];
  status: AddressBlacklistEntry["status"];
  created_by: string | null;
  created_at: Date;
  removed_by: string | null;
  removed_at: Date | null;
  removal_reason: string | null;
}

const ADDRESS_BLACKLIST_COLUMNS = `entry_id, network, address, category, reason, source, status,
              created_by, created_at, removed_by, removed_at, removal_reason`;

const WITHDRAWAL_COLUMNS = `withdrawal_id, user_id, ledger_account_id, custody_request_id, asset_code, network, to_address,
              amount::text as amount, fee::text as fee, frozen_amount::text as frozen_amount,
              freeze_reference_id, status, review_status, tx_hash, requested_at,
              approved_at, broadcasted_at, confirmed_at, risk_score, risk_level, risk_reasons, metadata`;

interface WithdrawalAddressBookRow {
  address_book_id: string;
  user_id: string;
  network: Network;
  address: string;
  label: string;
  is_whitelisted: boolean;
  created_at: Date;
}

interface WithdrawalAuditLogRow {
  audit_log_id: string;
  withdrawal_id: string;
  operator_id: string | null;
  operator_role: string | null;
  action: WithdrawalAuditLogRecord["action"];
  trace_id: string | null;
  before_snapshot: Record<string, unknown>;
  after_snapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface WalletNotificationRow {
  notification_id: string;
  user_id: string;
  withdrawal_id: string | null;
  deposit_id: string | null;
  read_at: Date | null;
  event_type: WalletNotificationRecord["eventType"];
  channel: WalletNotificationRecord["channel"];
  status: WalletNotificationRecord["status"];
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  delivery_attempts: number;
  delivery_receipt: Record<string, unknown>;
  created_at: Date;
  last_attempted_at: Date | null;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
}

const WALLET_NOTIFICATION_COLUMNS = `notification_id, user_id, withdrawal_id, deposit_id, event_type,
              channel, status, subject, body, payload, delivery_attempts, delivery_receipt,
              created_at, last_attempted_at, next_attempt_at, delivered_at, failed_at,
              last_error, read_at`;

export class PostgresWalletRepository implements WalletRepository {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly transactionOwner?: Pool
  ) {}

  async withTransaction<T>(operation: (repository: WalletRepository) => Promise<T>): Promise<T> {
    if (!this.transactionOwner) {
      return operation(this);
    }

    return withPgTransaction(this.transactionOwner, async (client) =>
      operation(new PostgresWalletRepository(client))
    );
  }

  async createDepositAddress(
    command: CreateDepositAddressCommand,
    address: string,
    now: string
  ): Promise<WalletAddress> {
    const result = await this.db.query<WalletAddressRow>(
      `insert into wallet_addresses
       (user_id, ledger_account_id, asset_code, network, address, status, created_at)
       values ($1, $2, $3, $4, $5, 'active', $6)
       returning wallet_address_id, user_id, ledger_account_id, asset_code, network, address, status, created_at`,
      [
        command.userId,
        command.ledgerAccountId,
        command.assetCode,
        command.network,
        address,
        now
      ]
    );

    return mapWalletAddress(result.rows[0]);
  }

  async findDepositAddress(network: Network, address: string): Promise<WalletAddress | null> {
    const result = await this.db.query<WalletAddressRow>(
      `select wallet_address_id, user_id, ledger_account_id, asset_code, network, address, status, created_at
       from wallet_addresses
       where network = $1 and address = $2`,
      [network, address]
    );

    return result.rows[0] ? mapWalletAddress(result.rows[0]) : null;
  }

  async findDepositByUniqueKey(
    network: Network,
    txHash: string,
    address: string
  ): Promise<DepositRecord | null> {
    const result = await this.db.query<DepositRow>(
      `select deposit_id, user_id, ledger_account_id, ledger_journal_id, asset_code, network, address, tx_hash,
              amount::text as amount, block_number, confirmations, status, detected_at, confirmed_at, credited_at, metadata
       from deposits
       where network = $1 and tx_hash = $2 and address = $3`,
      [network, txHash, address]
    );

    return result.rows[0] ? mapDeposit(result.rows[0]) : null;
  }

  async listDepositAddresses(query: ListDepositAddressesQuery): Promise<PagedResult<WalletAddress>> {
    const { whereClause, values } = buildDepositAddressWhereClause(query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<WalletAddressRow>(
      `select wallet_address_id, user_id, ledger_account_id, asset_code, network, address, status, created_at
       from wallet_addresses
       ${whereClause}
       order by created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from wallet_addresses
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapWalletAddress),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async saveDeposit(record: DepositRecord): Promise<void> {
    await this.db.query(
      `insert into deposits
       (deposit_id, user_id, ledger_account_id, ledger_journal_id, asset_code, network, address, tx_hash,
        amount, block_number, confirmations, status, detected_at, confirmed_at, credited_at, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14, $15, $16::jsonb)
       on conflict (network, tx_hash, address) do update
       set ledger_account_id = excluded.ledger_account_id,
           ledger_journal_id = excluded.ledger_journal_id,
           amount = excluded.amount,
           block_number = excluded.block_number,
           confirmations = excluded.confirmations,
           status = excluded.status,
           confirmed_at = excluded.confirmed_at,
           credited_at = excluded.credited_at,
           metadata = excluded.metadata`,
      [
        record.depositId,
        record.userId,
        record.ledgerAccountId,
        record.ledgerJournalId ?? null,
        record.assetCode,
        record.network,
        record.address,
        record.txHash,
        record.amount,
        record.blockNumber ?? null,
        record.confirmations,
        record.status,
        record.detectedAt,
        record.confirmedAt ?? null,
        record.creditedAt ?? null,
        JSON.stringify(record.metadata)
      ]
    );
  }

  async findDepositById(depositId: string): Promise<DepositRecord | null> {
    const result = await this.db.query<DepositRow>(
      `select deposit_id, user_id, ledger_account_id, ledger_journal_id, asset_code, network, address, tx_hash,
              amount::text as amount, block_number, confirmations, status, detected_at, confirmed_at, credited_at, metadata
       from deposits
       where deposit_id = $1`,
      [depositId]
    );

    return result.rows[0] ? mapDeposit(result.rows[0]) : null;
  }

  async listDeposits(query: ListDepositsQuery): Promise<PagedResult<DepositRecord>> {
    const { whereClause, values } = buildDepositWhereClause(query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<DepositRow>(
      `select deposit_id, user_id, ledger_account_id, ledger_journal_id, asset_code, network, address, tx_hash,
              amount::text as amount, block_number, confirmations, status, detected_at, confirmed_at, credited_at, metadata
       from deposits
       ${whereClause}
       order by detected_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from deposits
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapDeposit),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async saveWithdrawal(record: WithdrawalRecord): Promise<void> {
    await this.db.query(
      `insert into withdrawals
       (withdrawal_id, user_id, ledger_account_id, custody_request_id, asset_code, network, to_address, amount, fee,
        frozen_amount, freeze_reference_id, status, review_status, tx_hash, requested_at,
        approved_at, broadcasted_at, confirmed_at, metadata, risk_score, risk_level, risk_reasons)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11, $12, $13, $14,
               $15, $16, $17, $18, $19::jsonb, $20, $21, $22::jsonb)
       on conflict (withdrawal_id) do update
       set ledger_account_id = excluded.ledger_account_id,
           custody_request_id = excluded.custody_request_id,
           amount = excluded.amount,
           fee = excluded.fee,
           frozen_amount = excluded.frozen_amount,
           freeze_reference_id = excluded.freeze_reference_id,
           status = excluded.status,
           review_status = excluded.review_status,
           tx_hash = excluded.tx_hash,
           approved_at = excluded.approved_at,
           broadcasted_at = excluded.broadcasted_at,
           confirmed_at = excluded.confirmed_at,
           metadata = excluded.metadata,
           risk_score = excluded.risk_score,
           risk_level = excluded.risk_level,
           risk_reasons = excluded.risk_reasons`,
      [
        record.withdrawalId,
        record.userId,
        record.ledgerAccountId,
        record.custodyRequestId ?? null,
        record.assetCode,
        record.network,
        record.toAddress,
        record.amount,
        record.fee,
        record.frozenAmount,
        record.freezeReferenceId,
        record.status,
        record.reviewStatus,
        record.txHash ?? null,
        record.requestedAt,
        record.approvedAt ?? null,
        record.broadcastedAt ?? null,
        record.confirmedAt ?? null,
        JSON.stringify(record.metadata),
        record.riskScore ?? null,
        record.riskLevel ?? null,
        JSON.stringify(record.riskReasons ?? [])
      ]
    );
  }

  async findWithdrawalById(withdrawalId: string): Promise<WithdrawalRecord | null> {
    const result = await this.db.query<WithdrawalRow>(
      `select ${WITHDRAWAL_COLUMNS}
       from withdrawals
       where withdrawal_id = $1`,
      [withdrawalId]
    );

    return result.rows[0] ? mapWithdrawal(result.rows[0]) : null;
  }

  async findWithdrawalByTxHash(network: Network, txHash: string): Promise<WithdrawalRecord | null> {
    const result = await this.db.query<WithdrawalRow>(
      `select ${WITHDRAWAL_COLUMNS}
       from withdrawals
       where network = $1 and tx_hash = $2`,
      [network, txHash]
    );

    return result.rows[0] ? mapWithdrawal(result.rows[0]) : null;
  }

  async listWithdrawals(query: ListWithdrawalsQuery): Promise<PagedResult<WithdrawalRecord>> {
    const { whereClause, values } = buildWithdrawalWhereClause(query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<WithdrawalRow>(
      `select ${WITHDRAWAL_COLUMNS}
       from withdrawals
       ${whereClause}
       order by requested_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from withdrawals
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapWithdrawal),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async saveWithdrawalAuditLog(record: WithdrawalAuditLogRecord): Promise<void> {
    await this.db.query(
      `insert into withdrawal_audit_logs
       (audit_log_id, withdrawal_id, operator_id, operator_role, action, trace_id,
        before_snapshot, after_snapshot, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
      [
        record.auditLogId,
        record.withdrawalId,
        record.operatorId ?? null,
        record.operatorRole ?? null,
        record.action,
        record.traceId ?? null,
        JSON.stringify(record.beforeSnapshot),
        JSON.stringify(record.afterSnapshot),
        JSON.stringify(record.metadata),
        record.createdAt
      ]
    );
  }

  async listWithdrawalAuditLogs(
    query: ListWithdrawalAuditLogsQuery
  ): Promise<PagedResult<WithdrawalAuditLogRecord>> {
    const { whereClause, values } = buildWithdrawalAuditLogWhereClause(query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<WithdrawalAuditLogRow>(
      `select l.audit_log_id, l.withdrawal_id, l.operator_id, l.operator_role, l.action, l.trace_id,
              l.before_snapshot, l.after_snapshot, l.metadata, l.created_at
       from withdrawal_audit_logs l
       join withdrawals w on w.withdrawal_id = l.withdrawal_id
       ${whereClause}
       order by l.created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from withdrawal_audit_logs l
       join withdrawals w on w.withdrawal_id = l.withdrawal_id
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapWithdrawalAuditLog),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async saveWalletNotification(record: WalletNotificationRecord): Promise<void> {
    await this.db.query(
      `insert into wallet_notifications
       (notification_id, user_id, withdrawal_id, event_type, channel, status,
        subject, body, payload, delivery_attempts, delivery_receipt, created_at,
        last_attempted_at, next_attempt_at, delivered_at, failed_at, last_error,
        deposit_id, read_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12,
               $13, $14, $15, $16, $17, $18, $19)
       on conflict do nothing`,
      [
        record.notificationId,
        record.userId,
        record.withdrawalId ?? null,
        record.eventType,
        record.channel,
        record.status,
        record.subject,
        record.body,
        JSON.stringify(record.payload),
        record.deliveryAttempts,
        JSON.stringify(record.deliveryReceipt),
        record.createdAt,
        record.lastAttemptedAt ?? null,
        record.nextAttemptAt ?? null,
        record.deliveredAt ?? null,
        record.failedAt ?? null,
        record.lastError ?? null,
        record.depositId ?? null,
        record.readAt ?? null
      ]
    );
  }

  async listDeliverableWalletNotifications(
    limit: number,
    now: string
  ): Promise<WalletNotificationRecord[]> {
    const result = await this.db.query<WalletNotificationRow>(
      `select ${WALLET_NOTIFICATION_COLUMNS}
       from wallet_notifications
       where status = 'pending'
         and (next_attempt_at is null or next_attempt_at <= $2)
       order by coalesce(next_attempt_at, created_at) asc, created_at asc
       limit $1`,
      [limit, now]
    );

    return result.rows.map(mapWalletNotification);
  }

  async markWalletNotificationDelivered(params: {
    notificationId: string;
    attemptedAt: string;
    deliveredAt: string;
    deliveryReceipt?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `update wallet_notifications
       set status = 'delivered',
           delivery_attempts = delivery_attempts + 1,
           delivery_receipt = $2::jsonb,
           last_attempted_at = $3,
           next_attempt_at = null,
           delivered_at = $4,
           failed_at = null,
           last_error = null
       where notification_id = $1`,
      [
        params.notificationId,
        JSON.stringify(params.deliveryReceipt ?? {}),
        params.attemptedAt,
        params.deliveredAt
      ]
    );
  }

  async recordWalletNotificationFailure(params: {
    notificationId: string;
    attemptedAt: string;
    errorMessage: string;
    nextAttemptAt?: string;
    failedAt?: string;
  }): Promise<void> {
    await this.db.query(
      `update wallet_notifications
       set status = case when $5::timestamptz is null then 'pending' else 'failed' end,
           delivery_attempts = delivery_attempts + 1,
           last_attempted_at = $2,
           next_attempt_at = $4,
           failed_at = $5,
           last_error = $3
       where notification_id = $1`,
      [
        params.notificationId,
        params.attemptedAt,
        params.errorMessage,
        params.nextAttemptAt ?? null,
        params.failedAt ?? null
      ]
    );
  }

  async listWalletNotifications(
    query: ListWithdrawalNotificationsQuery
  ): Promise<PagedResult<WalletNotificationRecord>> {
    const { whereClause, values } = buildWalletNotificationWhereClause(query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<WalletNotificationRow>(
      `select ${WALLET_NOTIFICATION_COLUMNS}
       from wallet_notifications
       ${whereClause}
       order by created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from wallet_notifications
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapWalletNotification),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async findWalletNotificationById(notificationId: string): Promise<WalletNotificationRecord | null> {
    const result = await this.db.query<WalletNotificationRow>(
      `select ${WALLET_NOTIFICATION_COLUMNS}
       from wallet_notifications
       where notification_id = $1`,
      [notificationId]
    );
    const row = result.rows[0];
    return row ? mapWalletNotification(row) : null;
  }

  async markWalletNotificationsRead(params: {
    userId: string;
    notificationIds?: string[];
    readAt: string;
  }): Promise<number> {
    const result = await this.db.query(
      `update wallet_notifications
       set read_at = $2
       where user_id = $1
         and read_at is null
         and ($3::uuid[] is null or notification_id = any($3::uuid[]))`,
      [params.userId, params.readAt, params.notificationIds ?? null]
    );
    return result.rowCount ?? 0;
  }

  async countUnreadWalletNotifications(userId: string): Promise<number> {
    const result = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from wallet_notifications
       where user_id = $1 and read_at is null`,
      [userId]
    );
    return Number(result.rows[0]?.total ?? "0");
  }

  async upsertWithdrawalAddressBookEntry(
    command: UpsertWithdrawalAddressBookEntryCommand,
    now: string
  ): Promise<WithdrawalAddressBookEntry> {
    const result = await this.db.query<WithdrawalAddressBookRow>(
      `insert into withdrawal_address_book
       (user_id, network, address, label, is_whitelisted, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, network, address) do update
       set label = excluded.label,
           is_whitelisted = excluded.is_whitelisted
       returning address_book_id, user_id, network, address, label, is_whitelisted, created_at`,
      [
        command.userId,
        command.network,
        command.address,
        command.label,
        command.isWhitelisted,
        now
      ]
    );

    return mapWithdrawalAddressBookEntry(result.rows[0]);
  }

  async findWithdrawalAddressBookEntryById(
    addressBookId: string
  ): Promise<WithdrawalAddressBookEntry | null> {
    const result = await this.db.query<WithdrawalAddressBookRow>(
      `select address_book_id, user_id, network, address, label, is_whitelisted, created_at
       from withdrawal_address_book
       where address_book_id = $1`,
      [addressBookId]
    );

    return result.rows[0] ? mapWithdrawalAddressBookEntry(result.rows[0]) : null;
  }

  async findWithdrawalAddressBookEntryByUniqueKey(
    command: Pick<CreateWithdrawalAddressBookEntryCommand, "userId" | "network" | "address">
  ): Promise<WithdrawalAddressBookEntry | null> {
    const result = await this.db.query<WithdrawalAddressBookRow>(
      `select address_book_id, user_id, network, address, label, is_whitelisted, created_at
       from withdrawal_address_book
       where user_id = $1 and network = $2 and address = $3`,
      [command.userId, command.network, command.address]
    );

    return result.rows[0] ? mapWithdrawalAddressBookEntry(result.rows[0]) : null;
  }

  async listWithdrawalAddressBookEntries(
    query: ListWithdrawalAddressBookQuery
  ): Promise<PagedResult<WithdrawalAddressBookEntry>> {
    const { whereClause, values } = buildWithdrawalAddressBookWhereClause(query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<WithdrawalAddressBookRow>(
      `select address_book_id, user_id, network, address, label, is_whitelisted, created_at
       from withdrawal_address_book
       ${whereClause}
       order by created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );

    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from withdrawal_address_book
       ${whereClause}`,
      values
    );

    return {
      items: rows.rows.map(mapWithdrawalAddressBookEntry),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async setWithdrawalAddressWhitelistStatus(
    command: SetWithdrawalAddressWhitelistStatusCommand
  ): Promise<WithdrawalAddressBookEntry | null> {
    const result = await this.db.query<WithdrawalAddressBookRow>(
      `update withdrawal_address_book
       set is_whitelisted = $2
       where address_book_id = $1
       returning address_book_id, user_id, network, address, label, is_whitelisted, created_at`,
      [command.addressBookId, command.isWhitelisted]
    );

    return result.rows[0] ? mapWithdrawalAddressBookEntry(result.rows[0]) : null;
  }

  async isWithdrawalAddressWhitelisted(
    userId: string,
    network: Network,
    address: string
  ): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `select exists(
         select 1
         from withdrawal_address_book
         where user_id = $1
           and network = $2
           and address = $3
           and is_whitelisted = true
       ) as exists`,
      [userId, network, address]
    );

    return result.rows[0]?.exists ?? false;
  }

  async sumWithdrawalsForUser(params: {
    userId: string;
    assetCode: AssetCode;
    from: string;
    to: string;
  }): Promise<string> {
    const result = await this.db.query<{ amount: string }>(
      `select amount::text as amount
       from withdrawals
       where user_id = $1
         and asset_code = $2
         and requested_at >= $3
         and requested_at < $4
         and status not in ('failed', 'rejected')`,
      [params.userId, params.assetCode, params.from, params.to]
    );

    return sumAmounts(result.rows.map((row) => row.amount));
  }

  async countSuccessfulWithdrawalsToAddress(params: {
    userId: string;
    network: Network;
    address: string;
  }): Promise<number> {
    const result = await this.db.query<{ total: string }>(
      `select count(*)::text as total
       from withdrawals
       where user_id = $1
         and network = $2
         and to_address = $3
         and status in ('approved', 'broadcasted', 'confirmed')`,
      [params.userId, params.network, params.address]
    );
    return Number(result.rows[0]?.total ?? "0");
  }

  async listAddressBlacklist(
    query: ListAddressBlacklistQuery
  ): Promise<PagedResult<AddressBlacklistEntry>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    pushCondition(conditions, values, "network", query.network);
    pushCondition(conditions, values, "address", query.address);
    pushCondition(conditions, values, "status", query.status);
    pushCondition(conditions, values, "category", query.category);
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const rows = await this.db.query<AddressBlacklistRow>(
      `select ${ADDRESS_BLACKLIST_COLUMNS}
       from withdrawal_address_blacklist
       ${whereClause}
       order by created_at desc
       limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]
    );
    const countResult = await this.db.query<{ total: string }>(
      `select count(*)::text as total from withdrawal_address_blacklist ${whereClause}`,
      values
    );
    return {
      items: rows.rows.map(mapAddressBlacklistEntry),
      total: Number(countResult.rows[0]?.total ?? "0"),
      limit,
      offset
    };
  }

  async findActiveAddressBlacklistEntry(
    network: Network,
    address: string
  ): Promise<AddressBlacklistEntry | null> {
    const result = await this.db.query<AddressBlacklistRow>(
      `select ${ADDRESS_BLACKLIST_COLUMNS}
       from withdrawal_address_blacklist
       where network = $1 and address = $2 and status = 'active'
       limit 1`,
      [network, address]
    );
    return result.rows[0] ? mapAddressBlacklistEntry(result.rows[0]) : null;
  }

  async findAddressBlacklistEntryById(entryId: string): Promise<AddressBlacklistEntry | null> {
    const result = await this.db.query<AddressBlacklistRow>(
      `select ${ADDRESS_BLACKLIST_COLUMNS}
       from withdrawal_address_blacklist
       where entry_id = $1`,
      [entryId]
    );
    return result.rows[0] ? mapAddressBlacklistEntry(result.rows[0]) : null;
  }

  async saveAddressBlacklistEntry(entry: AddressBlacklistEntry): Promise<void> {
    await this.db.query(
      `insert into withdrawal_address_blacklist
       (entry_id, network, address, category, reason, source, status, created_by, created_at,
        removed_by, removed_at, removal_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (entry_id) do update
       set status = excluded.status,
           reason = excluded.reason,
           category = excluded.category,
           removed_by = excluded.removed_by,
           removed_at = excluded.removed_at,
           removal_reason = excluded.removal_reason`,
      [
        entry.entryId,
        entry.network,
        entry.address,
        entry.category,
        entry.reason,
        entry.source,
        entry.status,
        entry.createdBy ?? null,
        entry.createdAt,
        entry.removedBy ?? null,
        entry.removedAt ?? null,
        entry.removalReason ?? null
      ]
    );
  }
}

function buildDepositWhereClause(query: ListDepositsQuery): {
  whereClause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  pushCondition(conditions, values, "user_id", query.userId);
  pushCondition(conditions, values, "ledger_account_id", query.ledgerAccountId);
  pushCondition(conditions, values, "asset_code", query.assetCode);
  pushCondition(conditions, values, "network", query.network);
  pushCondition(conditions, values, "status", query.status);
  pushCondition(conditions, values, "tx_hash", query.txHash);
  pushCondition(conditions, values, "address", query.address);

  return {
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
    values
  };
}

function buildDepositAddressWhereClause(query: ListDepositAddressesQuery): {
  whereClause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  pushCondition(conditions, values, "user_id", query.userId);
  pushCondition(conditions, values, "ledger_account_id", query.ledgerAccountId);
  pushCondition(conditions, values, "asset_code", query.assetCode);
  pushCondition(conditions, values, "network", query.network);
  pushCondition(conditions, values, "status", query.status);
  pushCondition(conditions, values, "address", query.address);

  return {
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
    values
  };
}

function buildWithdrawalWhereClause(query: ListWithdrawalsQuery): {
  whereClause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  pushCondition(conditions, values, "user_id", query.userId);
  pushCondition(conditions, values, "ledger_account_id", query.ledgerAccountId);
  pushCondition(conditions, values, "asset_code", query.assetCode);
  pushCondition(conditions, values, "network", query.network);
  pushCondition(conditions, values, "status", query.status);
  pushCondition(conditions, values, "review_status", query.reviewStatus);
  if (query.reviewStatuses && query.reviewStatuses.length > 0) {
    values.push(query.reviewStatuses);
    conditions.push(`review_status = any($${values.length}::text[])`);
  }
  pushCondition(conditions, values, "tx_hash", query.txHash);
  pushCondition(conditions, values, "to_address", query.toAddress);
  pushCondition(conditions, values, "risk_level", query.riskLevel);

  return {
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
    values
  };
}

function buildWithdrawalAddressBookWhereClause(query: ListWithdrawalAddressBookQuery): {
  whereClause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  pushCondition(conditions, values, "user_id", query.userId);
  pushCondition(conditions, values, "network", query.network);
  pushCondition(conditions, values, "address", query.address);
  pushCondition(conditions, values, "is_whitelisted", query.isWhitelisted);

  return {
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
    values
  };
}

function buildWithdrawalAuditLogWhereClause(query: ListWithdrawalAuditLogsQuery): {
  whereClause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  pushCondition(conditions, values, "l.withdrawal_id", query.withdrawalId);
  pushCondition(conditions, values, "w.user_id", query.userId);
  pushCondition(conditions, values, "w.asset_code", query.assetCode);
  pushCondition(conditions, values, "w.network", query.network);
  pushCondition(conditions, values, "w.status", query.status);
  pushCondition(conditions, values, "w.review_status", query.reviewStatus);
  pushCondition(conditions, values, "w.tx_hash", query.txHash);
  pushCondition(conditions, values, "w.to_address", query.toAddress);
  pushCondition(conditions, values, "l.action", query.action);
  pushCondition(conditions, values, "l.operator_id", query.operatorId);

  return {
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
    values
  };
}

function buildWalletNotificationWhereClause(query: ListWithdrawalNotificationsQuery): {
  whereClause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

  pushCondition(conditions, values, "user_id", query.userId);
  pushCondition(conditions, values, "withdrawal_id", query.withdrawalId);
  pushCondition(conditions, values, "event_type", query.eventType);
  pushCondition(conditions, values, "status", query.status);
  pushCondition(conditions, values, "channel", query.channel);
  pushCondition(conditions, values, "deposit_id", query.depositId);
  if (query.readState === "read") {
    conditions.push("read_at is not null");
  } else if (query.readState === "unread") {
    conditions.push("read_at is null");
  }

  return {
    whereClause: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
    values
  };
}

function pushCondition(
  conditions: string[],
  values: unknown[],
  column: string,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }

  values.push(value);
  conditions.push(`${column} = $${values.length}`);
}

function mapWalletAddress(row: WalletAddressRow | undefined): WalletAddress {
  if (!row) {
    throw new Error("Wallet address row is required");
  }

  return {
    walletAddressId: row.wallet_address_id,
    userId: row.user_id,
    ledgerAccountId: row.ledger_account_id,
    assetCode: row.asset_code,
    network: row.network,
    address: row.address,
    status: row.status,
    createdAt: row.created_at.toISOString()
  };
}

function mapDeposit(row: DepositRow): DepositRecord {
  return {
    depositId: row.deposit_id,
    userId: row.user_id,
    ledgerAccountId: row.ledger_account_id,
    ledgerJournalId: row.ledger_journal_id ?? undefined,
    assetCode: row.asset_code,
    network: row.network,
    address: row.address,
    txHash: row.tx_hash,
    amount: row.amount,
    blockNumber: row.block_number ?? undefined,
    confirmations: row.confirmations,
    status: row.status,
    detectedAt: row.detected_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString(),
    creditedAt: row.credited_at?.toISOString(),
    metadata: row.metadata
  };
}

function mapWithdrawal(row: WithdrawalRow): WithdrawalRecord {
  return {
    withdrawalId: row.withdrawal_id,
    userId: row.user_id,
    ledgerAccountId: row.ledger_account_id ?? "",
    custodyRequestId: row.custody_request_id ?? undefined,
    assetCode: row.asset_code,
    network: row.network,
    toAddress: row.to_address,
    amount: row.amount,
    fee: row.fee,
    frozenAmount: row.frozen_amount,
    freezeReferenceId: row.freeze_reference_id ?? row.withdrawal_id,
    status: row.status,
    reviewStatus: row.review_status,
    requestedAt: row.requested_at.toISOString(),
    approvedAt: row.approved_at?.toISOString(),
    broadcastedAt: row.broadcasted_at?.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString(),
    txHash: row.tx_hash ?? undefined,
    riskScore: row.risk_score ?? undefined,
    riskLevel: row.risk_level ?? undefined,
    riskReasons: row.risk_level ? row.risk_reasons ?? [] : undefined,
    metadata: row.metadata
  };
}

function mapAddressBlacklistEntry(row: AddressBlacklistRow): AddressBlacklistEntry {
  return {
    entryId: row.entry_id,
    network: row.network,
    address: row.address,
    category: row.category,
    reason: row.reason,
    source: row.source,
    status: row.status,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    removedBy: row.removed_by ?? undefined,
    removedAt: row.removed_at?.toISOString(),
    removalReason: row.removal_reason ?? undefined
  };
}

function mapWithdrawalAddressBookEntry(
  row: WithdrawalAddressBookRow | undefined
): WithdrawalAddressBookEntry {
  if (!row) {
    throw new Error("Withdrawal address book row is required");
  }

  return {
    addressBookId: row.address_book_id,
    userId: row.user_id,
    network: row.network,
    address: row.address,
    label: row.label,
    isWhitelisted: row.is_whitelisted,
    createdAt: row.created_at.toISOString()
  };
}

function mapWithdrawalAuditLog(row: WithdrawalAuditLogRow): WithdrawalAuditLogRecord {
  return {
    auditLogId: row.audit_log_id,
    withdrawalId: row.withdrawal_id,
    operatorId: row.operator_id ?? undefined,
    operatorRole: row.operator_role ?? undefined,
    action: row.action,
    traceId: row.trace_id ?? undefined,
    beforeSnapshot: row.before_snapshot,
    afterSnapshot: row.after_snapshot,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString()
  };
}

function mapWalletNotification(row: WalletNotificationRow): WalletNotificationRecord {
  return {
    notificationId: row.notification_id,
    userId: row.user_id,
    withdrawalId: row.withdrawal_id ?? undefined,
    depositId: row.deposit_id ?? undefined,
    eventType: row.event_type,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    body: row.body,
    payload: row.payload,
    deliveryAttempts: Number(row.delivery_attempts),
    deliveryReceipt: row.delivery_receipt ?? {},
    createdAt: row.created_at.toISOString(),
    lastAttemptedAt: row.last_attempted_at?.toISOString(),
    nextAttemptAt: row.next_attempt_at?.toISOString(),
    deliveredAt: row.delivered_at?.toISOString(),
    failedAt: row.failed_at?.toISOString(),
    lastError: row.last_error ?? undefined,
    readAt: row.read_at?.toISOString()
  };
}
