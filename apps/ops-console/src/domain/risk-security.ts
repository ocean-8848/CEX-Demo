import type { PagedResponse } from "./clients.js";

/** Simplified KYT blacklist (wallet-service) + login security (identity-service). */

export interface OpsAddressBlacklistQuery {
  network?: string;
  address?: string;
  status?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export interface OpsAddAddressBlacklistCommand {
  network: string;
  address: string;
  category: string;
  reason: string;
}

export interface OpsRemoveAddressBlacklistCommand {
  entryId: string;
  reason: string;
}

export interface OpsLoginEventsQuery {
  limit?: number;
  offset?: number;
}

export interface OpsRiskSecurityClient {
  listAddressBlacklist(query: OpsAddressBlacklistQuery): Promise<PagedResponse<Record<string, unknown>>>;
  addAddressBlacklistEntry(
    command: OpsAddAddressBlacklistCommand & { createdBy: string }
  ): Promise<Record<string, unknown>>;
  removeAddressBlacklistEntry(
    command: OpsRemoveAddressBlacklistCommand & { removedBy: string }
  ): Promise<Record<string, unknown>>;
  listAddressRiskLabels(): Promise<Record<string, unknown>>;
  listLoginEvents(userId: string, query: OpsLoginEventsQuery): Promise<PagedResponse<Record<string, unknown>>>;
  listDevices(userId: string): Promise<Record<string, unknown>>;
  revokeDevice(userId: string, deviceId: string): Promise<Record<string, unknown>>;
}

/** Permission points (identity-service rbac.ts). */
export const OPS_RISK_READ = "ops.risk.read";
export const OPS_RISK_MANAGE = "ops.risk.manage";
