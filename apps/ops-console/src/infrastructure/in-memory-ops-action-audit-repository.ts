import type {
  CreateOpsActionAuditLogCommand,
  OpsActionAuditLog,
  OpsActionAuditLogQuery,
  OpsActionAuditRepository
} from "../domain/action-audit.js";
import type { PagedResponse } from "../domain/clients.js";

export class InMemoryOpsActionAuditRepository implements OpsActionAuditRepository {
  private readonly logs = new Map<string, OpsActionAuditLog>();

  constructor(private readonly createId: () => string = defaultCreateId) {}

  async save(command: CreateOpsActionAuditLogCommand): Promise<OpsActionAuditLog> {
    const log: OpsActionAuditLog = {
      auditLogId: this.createId(),
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

    this.logs.set(log.auditLogId, log);
    return log;
  }

  async list(query: OpsActionAuditLogQuery): Promise<PagedResponse<OpsActionAuditLog>> {
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);
    const filtered = [...this.logs.values()]
      .filter((log) => {
        if (query.batchId && log.batchId !== query.batchId) {
          return false;
        }
        if (query.operatorUserId && log.operatorUserId !== query.operatorUserId) {
          return false;
        }
        if (query.action && log.action !== query.action) {
          return false;
        }
        if (query.permission && log.permission !== query.permission) {
          return false;
        }
        if (query.targetType && log.targetType !== query.targetType) {
          return false;
        }
        if (query.targetId && log.targetId !== query.targetId) {
          return false;
        }
        if (query.status && log.status !== query.status) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset
    };
  }
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

function cloneRecord(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function defaultCreateId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `audit_${Date.now()}`;
}
