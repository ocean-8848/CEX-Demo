import type { OpsSessionInfo, PagedResponse } from "./clients.js";

export type OpsActionAuditStatus = "succeeded" | "failed";

export interface OpsActionAuditLog {
  auditLogId: string;
  batchId?: string;
  operatorUserId: string;
  operatorEmail?: string;
  operatorRoles: string[];
  permission: string;
  action: string;
  targetType: string;
  targetId?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  status: OpsActionAuditStatus;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
}

export interface OpsActionAuditLogQuery {
  batchId?: string;
  operatorUserId?: string;
  action?: string;
  permission?: string;
  targetType?: string;
  targetId?: string;
  status?: OpsActionAuditStatus;
  limit?: number;
  offset?: number;
}

export interface CreateOpsActionAuditLogCommand {
  batchId?: string;
  operator: OpsSessionInfo;
  permission: string;
  action: string;
  targetType: string;
  targetId?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  status: OpsActionAuditStatus;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
}

export interface OpsActionAuditRepository {
  save(command: CreateOpsActionAuditLogCommand): Promise<OpsActionAuditLog>;
  list(query: OpsActionAuditLogQuery): Promise<PagedResponse<OpsActionAuditLog>>;
}
