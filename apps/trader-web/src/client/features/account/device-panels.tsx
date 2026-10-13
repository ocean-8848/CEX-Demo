import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Empty, Panel, formatDateTime } from "@web3-cex/web-ui";

import { createApiClient, readErrorMessage } from "../../lib/api.js";
import { getDeviceId } from "../../lib/device.js";
import type { LoginEventRecord, PagedResult, UserDeviceRecord } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";

const OUTCOME_LABEL: Record<LoginEventRecord["outcome"], { text: string; tone: "positive" | "negative" | "warning" }> = {
  success: { text: "成功", tone: "positive" },
  failure: { text: "失败", tone: "negative" },
  locked: { text: "已锁定", tone: "warning" }
};

const FAILURE_LABEL: Record<string, string> = {
  INVALID_CREDENTIALS: "密码错误",
  TWO_FACTOR_REQUIRED: "需要动态码",
  TWO_FACTOR_INVALID_CODE: "动态码错误",
  TWO_FACTOR_CODE_REUSED: "动态码已用过",
  TWO_FACTOR_RECOVERY_CODE_INVALID: "恢复码无效",
  LOGIN_TEMPORARILY_LOCKED: "失败次数过多，临时锁定",
  USER_NOT_ACTIVE: "账户已冻结"
};

const NEW_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 账户 → 登录记录 / 设备管理. Data comes from identity-service through the
 * gateway (session only): every login attempt with device, IP and result, and
 * the devices seen on this account with their active sessions.
 */
export function LoginSecurityPanels() {
  const { state, actions } = useExchange();
  const [events, setEvents] = useState<LoginEventRecord[]>([]);
  const [devices, setDevices] = useState<UserDeviceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const currentDeviceId = getDeviceId();
  const config = state.config;

  const load = useCallback(async () => {
    if (!config) {
      return;
    }
    const client = createApiClient(config);
    setLoading(true);
    setError(null);
    try {
      const [eventPage, devicePage] = await Promise.all([
        client.gateway<PagedResult<LoginEventRecord>>("/auth/login-events?limit=20", { token: state.token }),
        client.gateway<{ items: UserDeviceRecord[] }>("/auth/devices", { token: state.token })
      ]);
      setEvents(eventPage.items ?? []);
      setDevices(devicePage.items ?? []);
    } catch (loadError) {
      setError(readErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [config, state.token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(device: UserDeviceRecord) {
    if (!config) {
      return;
    }
    setRevoking(device.deviceId);
    try {
      const result = await createApiClient(config).gateway<{ revokedSessionCount: number }>(
        `/auth/devices/${encodeURIComponent(device.deviceId)}/revoke`,
        { method: "POST", body: {}, token: state.token }
      );
      actions.toast("positive", "已退出该设备", `结束了 ${result.revokedSessionCount} 个会话`);
      if (device.deviceId === currentDeviceId) {
        await actions.logout();
        return;
      }
      await load();
    } catch (revokeError) {
      actions.toast("negative", "操作失败", readErrorMessage(revokeError));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="account-grid" id="login-security">
      <Panel
        title="设备管理"
        actions={
          <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      >
        <p className="muted">
          每次登录都会带上本浏览器保存的设备 ID；第一次出现的设备会标记为新设备并发送站内通知。
          「退出该设备」会吊销它上面的所有会话。
        </p>
        {error ? <p className="form-error">{error}</p> : null}
        {devices.length === 0 ? (
          <Empty icon="💻" title="暂无设备记录" />
        ) : (
          <div className="table-scroll">
            <table className="data-table" id="device-table">
              <thead>
                <tr>
                  <th>设备</th>
                  <th>最近登录</th>
                  <th>IP</th>
                  <th className="num">登录次数</th>
                  <th className="num">活跃会话</th>
                  <th className="num">操作</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => {
                  const isCurrent = device.deviceId === currentDeviceId;
                  const isRecentNew =
                    device.flaggedNew && Date.now() - Date.parse(device.firstSeenAt) < NEW_DEVICE_WINDOW_MS;
                  return (
                    <tr key={device.deviceId}>
                      <td>
                        {device.deviceLabel || "未知设备"}{" "}
                        {isCurrent ? <Badge tone="positive">本机</Badge> : null}
                        {isRecentNew ? <Badge tone="warning">新设备</Badge> : null}
                        <div className="muted">
                          <code>{device.deviceId}</code> · 首次 {formatDateTime(device.firstSeenAt)}
                        </div>
                      </td>
                      <td className="muted">{formatDateTime(device.lastSeenAt)}</td>
                      <td className="muted">{device.lastIpAddress ?? "--"}</td>
                      <td className="num">{device.loginCount ?? 0}</td>
                      <td className="num">{device.activeSessionCount ?? 0}</td>
                      <td className="num">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={(device.activeSessionCount ?? 0) === 0}
                          loading={revoking === device.deviceId}
                          onClick={() => void revoke(device)}
                        >
                          {isCurrent ? "退出本机" : "退出该设备"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="登录记录" actions={<span className="muted">最近 20 次（含失败）</span>}>
        {events.length === 0 ? (
          <Empty icon="🕘" title="暂无登录记录" />
        ) : (
          <div className="table-scroll">
            <table className="data-table" id="login-event-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>结果</th>
                  <th>设备</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const outcome = OUTCOME_LABEL[event.outcome] ?? OUTCOME_LABEL.failure;
                  return (
                    <tr key={event.eventId}>
                      <td className="muted">{formatDateTime(event.createdAt)}</td>
                      <td>
                        <Badge tone={outcome.tone}>{outcome.text}</Badge>
                        {event.failureCode ? (
                          <span className="muted"> {FAILURE_LABEL[event.failureCode] ?? event.failureCode}</span>
                        ) : null}
                        {event.isNewDevice ? <Badge tone="warning">新设备</Badge> : null}
                      </td>
                      <td>{event.deviceLabel || "--"}</td>
                      <td className="muted">{event.ipAddress ?? "--"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
