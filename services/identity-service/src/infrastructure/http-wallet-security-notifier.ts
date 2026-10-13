import type { NewDeviceLoginNotice, SecurityNotifier } from "../domain/login-security.js";
import { buildInternalServiceHeaders } from "./internal-service-request.js";

/**
 * The customer inbox belongs to wallet-service (wallet_notifications), so the
 * "新设备登录" message is created there through an internal HMAC call.
 */
export class HttpWalletSecurityNotifier implements SecurityNotifier {
  constructor(private readonly baseUrl: string) {}

  async notifyNewDeviceLogin(notice: NewDeviceLoginNotice): Promise<void> {
    const path = "/api/v1/wallet/notifications/security";
    const body = JSON.stringify({
      userId: notice.userId,
      eventType: "security.new_device_login",
      subject: "新设备登录",
      body:
        `你的账户于 ${notice.loggedInAt} 在一台新设备（${notice.deviceLabel}` +
        `${notice.ipAddress ? `，IP ${notice.ipAddress}` : ""}）上登录。` +
        "如果不是你本人操作，请立即在「账户 → 设备管理」中退出该设备并修改密码。",
      payload: {
        deviceId: notice.deviceId,
        deviceLabel: notice.deviceLabel,
        ipAddress: notice.ipAddress,
        loggedInAt: notice.loggedInAt
      }
    });
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      body,
      headers: buildInternalServiceHeaders({
        method: "POST",
        path,
        rawBody: body,
        headers: { "content-type": "application/json" }
      }),
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) {
      throw new Error(`wallet-service rejected security notification: ${response.status} ${await response.text()}`);
    }
  }
}
