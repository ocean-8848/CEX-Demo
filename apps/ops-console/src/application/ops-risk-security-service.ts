import type { OpsSessionInfo } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import {
  OPS_RISK_MANAGE,
  type OpsAddAddressBlacklistCommand,
  type OpsAddressBlacklistQuery,
  type OpsLoginEventsQuery,
  type OpsRemoveAddressBlacklistCommand,
  type OpsRiskSecurityClient
} from "../domain/risk-security.js";
import type { AuditedActionOptions } from "./ops-console-application-service.js";

type AuditedRunner = <T>(options: AuditedActionOptions, operation: () => Promise<T>) => Promise<T>;

const BLACKLIST_CATEGORIES = ["sanctioned", "mixer", "scam", "hack", "other"];

/**
 * Ops side of withdrawal address risk (KYT blacklist) and login security
 * (login history, devices). Every write goes through the ops action audit.
 */
export class OpsRiskSecurityService {
  constructor(
    private readonly client: OpsRiskSecurityClient,
    private readonly runAudited: AuditedRunner
  ) {}

  listAddressBlacklist(query: OpsAddressBlacklistQuery) {
    return this.client.listAddressBlacklist(query);
  }

  listAddressRiskLabels() {
    return this.client.listAddressRiskLabels();
  }

  async addAddressBlacklistEntry(session: OpsSessionInfo, command: OpsAddAddressBlacklistCommand) {
    const reason = command.reason?.trim();
    if (!command.network || !command.address?.trim()) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "network and address are required");
    }
    if (!BLACKLIST_CATEGORIES.includes(command.category)) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, `category must be one of ${BLACKLIST_CATEGORIES.join(", ")}`);
    }
    if (!reason) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "A reason is required to blacklist an address");
    }
    return this.runAudited(
      {
        session,
        permission: OPS_RISK_MANAGE,
        action: "risk.blacklist.add",
        targetType: "address_blacklist",
        targetId: `${command.network}:${command.address.trim().toLowerCase()}`,
        requestPayload: { network: command.network, address: command.address, category: command.category, reason }
      },
      () =>
        this.client.addAddressBlacklistEntry({
          network: command.network,
          address: command.address.trim(),
          category: command.category,
          reason,
          createdBy: session.email ?? session.userId
        })
    );
  }

  async removeAddressBlacklistEntry(session: OpsSessionInfo, command: OpsRemoveAddressBlacklistCommand) {
    const reason = command.reason?.trim();
    if (!reason) {
      throw new OpsConsoleError("VALIDATION_ERROR", 400, "A reason is required to remove a blacklist entry");
    }
    return this.runAudited(
      {
        session,
        permission: OPS_RISK_MANAGE,
        action: "risk.blacklist.remove",
        targetType: "address_blacklist",
        targetId: command.entryId,
        requestPayload: { reason }
      },
      () =>
        this.client.removeAddressBlacklistEntry({
          entryId: command.entryId,
          reason,
          removedBy: session.email ?? session.userId
        })
    );
  }

  listUserLoginEvents(userId: string, query: OpsLoginEventsQuery) {
    return this.client.listLoginEvents(userId, query);
  }

  listUserDevices(userId: string) {
    return this.client.listDevices(userId);
  }

  /** Account-takeover response: end every session on one of the user's devices. */
  revokeUserDevice(session: OpsSessionInfo, userId: string, deviceId: string) {
    return this.runAudited(
      {
        session,
        permission: "ops.users.freeze",
        action: "user.device.revoke",
        targetType: "user_device",
        targetId: `${userId}:${deviceId}`,
        requestPayload: { userId, deviceId }
      },
      () => this.client.revokeDevice(userId, deviceId)
    );
  }
}
