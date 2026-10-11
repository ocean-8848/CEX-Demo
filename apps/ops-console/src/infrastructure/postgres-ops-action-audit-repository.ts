import type { Pool } from "pg";

import type {
  CreateOpsActionAuditLogCommand,
  OpsActionAuditLog,
  OpsActionAuditLogQuery,
  OpsActionAuditRepository
} from "../domain/action-audit.js";
import type { PagedResponse } from "../domain/clients.js";
import type { SqlClient } from "./postgres.js";

interface OpsActionAuditLogRow {
  audit_log_id: string;
  batch_id: string | null;
  operator_user_id: string;
  operator_email: string | null;
  operator_roles: string[] | null;
  permission: string;
  action: string;
  target_type: string;
  target_id: string | null;
  request_payload: Record<string, unknown> | null;
  response_payload: Record<string, unknown> | null;
  status: "succeeded" | "failed";
  error_code: string | null;
  error_message: string | null;
  started_at: Date | string;
  completed_at: Date | string;
}

interface CountRow {
  count: string;
}

export class PostgresOpsActionAuditRepository implements OpsActionAuditRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly pool: Pool,
    private readonly createId: () => string = defaultCreateId
  ) {}

  async save(command: CreateOpsActionAuditLogCommand): Promise<OpsActionAuditLog> {
    const auditLogId = this.createId();

    await this.db.query(
      `insert into ops_action_audit_logs (
         audit_log_id,
         batch_id,
         operator_user_id,
         operator_email,
         operator_roles,
         permission,
         action,
         target_type,
         target_id,
         request_payload,
         response_payload,
         status,
         error_code,
         error_message,
         started_at,
         completed_at
       )
       values (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16
       )`,
      [
        auditLogId,
        command.batchId ?? null,
        command.operator.userId,
        command.operator.email ?? null,
        JSON.stringify(command.operator.roles),
        command.permission,
        command.action,
        command.targetType,
        command.targetId ?? null,
        command.requestPayload ? JSON.stringify(command.requestPayload) : null,
        command.responsePayload ? JSON.stringify(command.responsePayload) : null,
        command.status,
        command.errorCode ?? null,
        command.errorMessage ?? null,
        command.startedAt,
        command.completedAt
      ]
    );

    return {
      auditLogId,
      batchId: command.batchId,
      operatorUserId: command.operator.userId,
      operatorEmail: command.operator.email,
      operatorRoles: [...command.operator.roles],
      permission: command.permission,
      action: command.action,
      targetType: command.targetType,
      targetId: command.targetId,
      requestPayload: cloneRecord(command.requestPayload),
      responsePayload: cloneRecord(command.responsePayload),
      status: command.status,
      errorCode: command.errorCode,
      errorMessage: command.errorMessage,
      startedAt: command.startedAt,
      completedAt: command.completedAt
    };
  }

  async list(query: OpsActionAuditLogQuery): Promise<PagedResponse<OpsActionAuditLog>> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (query.batchId) {
      values.push(query.batchId);
      where.push(`batch_id = $${values.length}`);
    }

    if (query.operatorUserId) {
      values.push(query.operatorUserId);
      where.push(`operator_user_id = $${values.length}`);
    }

    if (query.action) {
      values.push(query.action);
      where.push(`action = $${values.length}`);
    }

    if (query.permission) {
      values.push(query.permission);
      where.push(`permission = $${values.length}`);
    }

    if (query.targetType) {
      values.push(query.targetType);
      where.push(`target_type = $${values.length}`);
    }

    if (query.targetId) {
      values.push(query.targetId);
      where.push(`target_id = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);

    values.push(limit);
    const limitPlaceholder = `$${values.length}`;
    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;

    const [itemsResult, countResult] = await Promise.all([
      this.db.query<OpsActionAuditLogRow>(
        `select
           audit_log_id,
           batch_id,
           operator_user_id,
           operator_email,
           operator_roles,
           permission,
           action,
           target_type,
           target_id,
           request_payload,
           response_payload,
           status,
           error_code,
           error_message,
           started_at,
           completed_at
         from ops_action_audit_logs
         ${whereSql}
         order by started_at desc
         limit ${limitPlaceholder}
         offset ${offsetPlaceholder}`,
        values
      ),
      this.db.query<CountRow>(
        `select count(*)::text as count
         from ops_action_audit_logs
         ${whereSql}`,
        values.slice(0, values.length - 2)
      )
    ]);

    return {
      items: itemsResult.rows.map(mapOpsActionAuditLog),
      total: Number(countResult.rows[0]?.count ?? "0"),
      limit,
      offset
    };
  }

  getPool(): Pool {
    return this.pool;
  }
}

function mapOpsActionAuditLog(row: OpsActionAuditLogRow): OpsActionAuditLog {
  return {
    auditLogId: row.audit_log_id,
    batchId: row.batch_id ?? undefined,
    operatorUserId: row.operator_user_id,
    operatorEmail: row.operator_email ?? undefined,
    operatorRoles: row.operator_roles ?? [],
    permission: row.permission,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id ?? undefined,
    requestPayload: cloneRecord(row.request_payload ?? undefined),
    responsePayload: cloneRecord(row.response_payload ?? undefined),
    status: row.status,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at)
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }

  return Math.max(Math.trunc(offset), 0);
}

function defaultCreateId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `audit_${Date.now()}`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cloneRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
