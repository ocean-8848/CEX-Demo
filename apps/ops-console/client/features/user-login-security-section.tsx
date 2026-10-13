import { useState } from "react";

import { Badge, Button, Empty } from "@web3-cex/web-ui";

import { itemsOf, qs } from "../lib/api.js";
import type { Paged } from "../lib/types.js";
import { ConfirmDialog, Time } from "../components/kit.js";
import { useOpsAction, useOpsQuery } from "../state/hooks.js";
import { useSession } from "../state/session.js";

interface LoginEvent {
  eventId: string;
  deviceId: string;
  deviceLabel?: string;
  ipAddress?: string;
  outcome: "success" | "failure" | "locked";
  failureCode?: string;
  isNewDevice?: boolean;
  scope?: string;
  createdAt: string;
}

interface Device {
  deviceId: string;
  deviceLabel?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIpAddress?: string;
  loginCount?: number;
  flaggedNew?: boolean;
  activeSessionCount?: number;
}

const OUTCOME: Record<string, { label: string; tone: "positive" | "negative" | "warning" }> = {
  success: { label: "成功", tone: "positive" },
  failure: { label: "失败", tone: "negative" },
  locked: { label: "锁定", tone: "warning" }
};

/** User drawer: identity-service login history and devices (ATO investigation). */
export function UserLoginSecuritySection(props: { userId: string }) {
  const { can } = useSession();
  const { busy, run } = useOpsAction();
  const [revoking, setRevoking] = useState<Device | null>(null);
  const id = encodeURIComponent(props.userId);
  const events = useOpsQuery<Paged<LoginEvent>>(`/users/${id}/login-events${qs({ limit: 10 })}`);
  const devices = useOpsQuery<{ items: Device[] }>(`/users/${id}/devices`);
  const deviceRows = devices.data?.items ?? [];
  const eventRows = itemsOf<LoginEvent>(events.data);

  const revoke = async () => {
    if (!revoking) {
      return;
    }
    const result = await run<{ revokedSessionCount: number }>(
      "revoke-device",
      { path: `/users/${id}/devices/${encodeURIComponent(revoking.deviceId)}/revoke` },
      { success: "已退出该设备", detail: (value) => `吊销了 ${value.revokedSessionCount} 个会话` }
    );
    if (result) {
      setRevoking(null);
      devices.reload();
    }
  };

  return (
    <>
      <section id="user-devices">
        <h4>设备</h4>
        {deviceRows.length === 0 ? (
          <Empty title="暂无设备记录" />
        ) : (
          <table className="data-table compact">
            <thead>
              <tr><th>设备</th><th>最近登录</th><th>IP</th><th className="num">会话</th><th /></tr>
            </thead>
            <tbody>
              {deviceRows.map((device) => (
                <tr key={device.deviceId}>
                  <td>
                    {device.deviceLabel || "未知设备"} {device.flaggedNew ? <Badge tone="warning">新设备</Badge> : null}
                    <div className="muted small"><code>{device.deviceId}</code> · {device.loginCount ?? 0} 次</div>
                  </td>
                  <td><Time value={device.lastSeenAt} /></td>
                  <td className="muted">{device.lastIpAddress ?? "--"}</td>
                  <td className="num">{device.activeSessionCount ?? 0}</td>
                  <td className="num">
                    {can("ops.users.freeze") && (device.activeSessionCount ?? 0) > 0 ? (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(device)}>退出设备</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section id="user-login-events">
        <h4>登录记录（最近 10 次）</h4>
        {eventRows.length === 0 ? (
          <Empty title="暂无登录记录" />
        ) : (
          <table className="data-table compact">
            <tbody>
              {eventRows.map((event) => {
                const outcome = OUTCOME[event.outcome] ?? OUTCOME.failure!;
                return (
                  <tr key={event.eventId}>
                    <td><Time value={event.createdAt} /></td>
                    <td>
                      <Badge tone={outcome.tone}>{outcome.label}</Badge>
                      {event.failureCode ? <span className="muted small"> {event.failureCode}</span> : null}
                      {event.isNewDevice ? <Badge tone="warning">新设备</Badge> : null}
                    </td>
                    <td>{event.deviceLabel ?? "--"}</td>
                    <td className="muted">{event.ipAddress ?? "--"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <ConfirmDialog
        open={revoking !== null}
        title="退出该设备"
        description="吊销该设备上的全部会话（用户需重新登录），用于疑似盗号时的处置。操作写入审计。"
        confirmLabel="确认退出"
        danger
        busy={busy === "revoke-device"}
        onConfirm={() => void revoke()}
        onClose={() => setRevoking(null)}
      />
    </>
  );
}
