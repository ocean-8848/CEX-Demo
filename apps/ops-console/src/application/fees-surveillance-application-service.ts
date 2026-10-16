import { OpsConsoleError } from "../domain/errors.js";
import type { OpsSessionInfo } from "../domain/clients.js";
import type { HttpFeesSurveillanceClient } from "../infrastructure/http-fees-surveillance-client.js";
import type { AuditedActionOptions } from "./ops-console-application-service.js";

type AuditedRunner = <T>(options: AuditedActionOptions, operation: () => Promise<T>) => Promise<T>;
type Client = Pick<
  HttpFeesSurveillanceClient,
  | "getFeeTierConfig"
  | "getUserFeeTier"
  | "listFeeTierAudit"
  | "setFeeTierOverride"
  | "clearFeeTierOverride"
  | "getSurveillanceOverview"
  | "listSurveillanceAlerts"
  | "getSurveillanceAlert"
  | "updateSurveillanceAlertStatus"
  | "runSurveillanceScan"
>;

export const FEE_TIER_MANAGE_PERMISSION = "ops.users.manage";
export const SURVEILLANCE_READ_PERMISSION = "ops.markets.read";
export const SURVEILLANCE_MANAGE_PERMISSION = "ops.markets.manage";

/**
 * ops-console side of user fee tier + override and 市场监控. Every
 * write goes through the ops action audit log in addition to the upstream
 * service's own audit trail.
 */
export class FeesSurveillanceApplicationService {
  constructor(
    private readonly client: Client,
    private readonly runAudited: AuditedRunner
  ) {}

  getFeeTierConfig() {
    return this.client.getFeeTierConfig();
  }

  async getUserFeeTier(userId: string) {
    const [profile, audit] = await Promise.all([
      this.client.getUserFeeTier(userId),
      this.client.listFeeTierAudit(userId).catch(() => ({ items: [] }))
    ]);
    return { ...profile, audit: audit.items };
  }

  setFeeTierOverride(session: OpsSessionInfo, userId: string, body: { tier?: string; note?: string }) {
    const tier = body.tier?.trim();
    const note = requireNote(body.note);
    if (!tier) {
      throw new OpsConsoleError("FEE_TIER_REQUIRED", 400, "tier is required");
    }
    return this.runAudited(
      {
        session,
        permission: FEE_TIER_MANAGE_PERMISSION,
        action: "fee_tier.override.set",
        targetType: "user",
        targetId: userId,
        requestPayload: { tier, note }
      },
      () => this.client.setFeeTierOverride(userId, { tier, note, actor: operatorOf(session) })
    );
  }

  clearFeeTierOverride(session: OpsSessionInfo, userId: string, body: { note?: string }) {
    const note = requireNote(body.note);
    return this.runAudited(
      {
        session,
        permission: FEE_TIER_MANAGE_PERMISSION,
        action: "fee_tier.override.clear",
        targetType: "user",
        targetId: userId,
        requestPayload: { note }
      },
      () => this.client.clearFeeTierOverride(userId, { note, actor: operatorOf(session) })
    );
  }

  getSurveillanceOverview() {
    return this.client.getSurveillanceOverview();
  }

  listSurveillanceAlerts(query: Record<string, string | undefined>) {
    return this.client.listSurveillanceAlerts(query);
  }

  getSurveillanceAlert(alertId: string) {
    return this.client.getSurveillanceAlert(alertId);
  }

  updateSurveillanceAlertStatus(session: OpsSessionInfo, alertId: string, body: { status?: string; note?: string }) {
    const status = body.status?.trim() ?? "";
    if (!["open", "acknowledged", "dismissed"].includes(status)) {
      throw new OpsConsoleError("SURVEILLANCE_INVALID_STATUS", 400, "status must be open, acknowledged or dismissed");
    }
    const note = requireNote(body.note);
    return this.runAudited(
      {
        session,
        permission: SURVEILLANCE_MANAGE_PERMISSION,
        action: `surveillance.alert.${status === "open" ? "reopen" : status === "acknowledged" ? "acknowledge" : "dismiss"}`,
        targetType: "surveillance_alert",
        targetId: alertId,
        requestPayload: { status, note }
      },
      () => this.client.updateSurveillanceAlertStatus(alertId, { status, note, actor: operatorOf(session) })
    );
  }

  runSurveillanceScan(session: OpsSessionInfo) {
    return this.runAudited(
      {
        session,
        permission: SURVEILLANCE_MANAGE_PERMISSION,
        action: "surveillance.scan",
        targetType: "surveillance"
      },
      () => this.client.runSurveillanceScan()
    );
  }
}

function requireNote(note: string | undefined): string {
  const value = note?.trim();
  if (!value) {
    throw new OpsConsoleError("NOTE_REQUIRED", 400, "A note is required");
  }
  return value;
}

function operatorOf(session: OpsSessionInfo): string {
  return session.email ?? session.userId;
}
