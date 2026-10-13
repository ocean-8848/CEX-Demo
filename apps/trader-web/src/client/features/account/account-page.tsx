import { useState, type FormEvent } from "react";

import { Badge, Button, CopyButton, Empty, formatDateTime, Modal, Panel } from "@web3-cex/web-ui";

import { readErrorMessage } from "../../lib/api.js";
import { navigate } from "../../lib/router.js";
import type { ApiKeyRecord, ApiKeyScope } from "../../lib/types.js";
import { useExchange } from "../../state/store.js";
import { LoginSecurityPanels } from "./device-panels.js";
import { KycPanel, TwoFactorPanel } from "./security-panels.js";

export function AccountPage() {
  const { state, actions } = useExchange();
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyRecord | null>(null);
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["read", "trade"]);

  if (!state.token || !state.session) {
    return (
      <div className="page narrow">
        <Empty
          icon="🔒"
          title="登录后管理账户"
          action={
            <Button variant="primary" onClick={() => navigate("/login?redirect=/account")}>
              登录 / 注册
            </Button>
          }
        />
      </div>
    );
  }

  const session = state.session;

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    try {
      const key = await actions.createApiKey(label || "my-bot", scopes);
      setCreated(key);
      setLabel("");
    } catch (error) {
      actions.toast("negative", "创建失败", readErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  const activeKeys = state.apiKeys.filter((key) => key.status !== "revoked");
  const revokedKeys = state.apiKeys.filter((key) => key.status === "revoked");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>账户与安全</h1>
          <p className="muted">身份、会话与 API Key 由 identity-service 管理</p>
        </div>
      </div>

      <div className="account-grid">
        <Panel title="个人信息">
          <dl className="kv">
            <div>
              <dt>昵称</dt>
              <dd>{session.displayName ?? "--"}</dd>
            </div>
            <div>
              <dt>邮箱</dt>
              <dd>{session.email ?? "--"}</dd>
            </div>
            <div>
              <dt>用户 ID</dt>
              <dd>
                <code>{session.userId}</code>
              </dd>
            </div>
            <div>
              <dt>账户状态</dt>
              <dd>
                <Badge tone={session.status === "active" ? "positive" : "warning"}>{session.status ?? "--"}</Badge>
              </dd>
            </div>
            <div>
              <dt>现货账户</dt>
              <dd>
                <code>{state.spotAccountId || "--"}</code>
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title="当前会话">
          <dl className="kv">
            <div>
              <dt>认证方式</dt>
              <dd>Session Token · HttpOnly Cookie（页面脚本不可读）</dd>
            </div>
            <div>
              <dt>签发时间</dt>
              <dd>{formatDateTime(session.createdAt)}</dd>
            </div>
            <div>
              <dt>过期时间</dt>
              <dd>{formatDateTime(session.expiresAt)}</dd>
            </div>
            <div>
              <dt>私有推送</dt>
              <dd>
                <Badge tone={state.privateFeed === "live" ? "positive" : "warning"}>{state.privateFeed}</Badge>
                {state.lastSequence > 0 ? <span className="muted"> · 已收到序号 {state.lastSequence}</span> : null}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      <div className="account-grid">
        <TwoFactorPanel />
        <KycPanel />
      </div>

      <LoginSecurityPanels />

      <Panel
        title="API Key"
        actions={<span className="muted">用于程序化交易（量化机器人）</span>}
      >
        <form className="inline-form" onSubmit={createKey} id="api-key-form">
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Key 备注，例如 grid-bot" maxLength={40} />
          <div className="scope-picks" role="group" aria-label="权限范围">
            {SCOPE_OPTIONS.map((option) => (
              <label key={option.scope} title={option.hint}>
                <input
                  type="checkbox"
                  checked={scopes.includes(option.scope)}
                  disabled={option.scope === "read"}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, option.scope]
                        : current.filter((scope) => scope !== option.scope)
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
          <Button type="submit" variant="primary" loading={creating}>
            创建 API Key
          </Button>
        </form>
        {activeKeys.length === 0 && revokedKeys.length === 0 ? (
          <Empty icon="⚿" title="暂无 API Key" />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>备注</th>
                  <th>Key ID</th>
                  <th>权限</th>
                  <th>创建时间</th>
                  <th>最近使用</th>
                  <th>状态</th>
                  <th className="num">操作</th>
                </tr>
              </thead>
              <tbody>
                {[...activeKeys, ...revokedKeys].map((key) => (
                  <tr key={key.apiKeyId}>
                    <td>{key.label ?? "--"}</td>
                    <td>
                      {key.keyId ? <code>{key.keyId}</code> : <span className="muted" title="不含 keyId 的旧格式 Key，已无法使用，请吊销后重建">旧格式</span>}
                    </td>
                    <td>
                      {(key.scopes ?? []).map((scope) => (
                        <Badge key={scope} tone={scope === "withdraw" ? "warning" : "neutral"}>{SCOPE_LABEL[scope] ?? scope}</Badge>
                      ))}
                    </td>
                    <td className="muted">{formatDateTime(key.createdAt)}</td>
                    <td className="muted">{formatDateTime(key.lastUsedAt)}</td>
                    <td>
                      <Badge tone={key.status === "revoked" ? "neutral" : "positive"}>{key.status ?? "active"}</Badge>
                    </td>
                    <td className="num">
                      {key.status === "revoked" ? null : (
                        <Button size="sm" variant="ghost" onClick={() => void actions.revokeApiKey(key.apiKeyId)}>
                          吊销
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ApiSigningGuide />
      </Panel>

      <Modal open={Boolean(created)} title="API Key 已创建" onClose={() => setCreated(null)}>
        {created ? (
          <div className="secret-box">
            <p className="muted">Key ID（公开，放在 <code className="inline">X-API-Key</code> 请求头）</p>
            <code id="api-key-id">{created.keyId}</code>
            <CopyButton value={created.keyId ?? ""} label="复制 Key ID" />
            <p className="form-error">Secret 只显示这一次，请立即保存。它只用于本地计算签名，永远不要放进请求里。</p>
            <code id="api-key-secret">{created.secret}</code>
            <CopyButton value={created.secret ?? ""} label="复制 Secret" />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

const SCOPE_OPTIONS: Array<{ scope: ApiKeyScope; label: string; hint: string }> = [
  { scope: "read", label: "读取", hint: "查询余额、订单、成交（必选）" },
  { scope: "trade", label: "交易", hint: "下单与撤单" },
  { scope: "withdraw", label: "提现", hint: "发起提现、管理地址簿；真实交易所通常还要求 IP 白名单" }
];

const SCOPE_LABEL: Record<string, string> = { read: "读取", trade: "交易", withdraw: "提现" };

const SIGNING_EXAMPLE = `import { createHash, createHmac, randomUUID } from "node:crypto";

const keyId = process.env.CEX_API_KEY_ID;       // ak_…，公开标识
const secret = process.env.CEX_API_SECRET;      // sk_…，只在本地参与签名
const body = JSON.stringify({
  accountId: "<现货账户 ID>", market: "ETH-USDT",
  side: "buy", type: "limit", timeInForce: "gtc",
  price: "3150.00", quantity: "0.01", idempotencyKey: randomUUID()
});
const path = "/api/v1/gateway/orders";
const timestamp = String(Date.now());           // 毫秒时间戳，允许 5 分钟漂移
const nonce = randomUUID();                     // 每个请求唯一，重复使用会被拒绝

// 规范请求 = METHOD \n PATH \n TIMESTAMP \n NONCE \n sha256(body)
const canonical = ["POST", path, timestamp, nonce,
  createHash("sha256").update(body).digest("hex")].join("\n");
const signature = createHmac("sha256", secret).update(canonical).digest("hex");

await fetch("http://127.0.0.1:3007" + path, {
  method: "POST", body,
  headers: { "content-type": "application/json",
    "x-api-key": keyId, "x-api-timestamp": timestamp,
    "x-api-nonce": nonce, "x-api-signature": signature }
});`;

function ApiSigningGuide() {
  return (
    <details className="guide">
      <summary>如何用 API Key 调用接口（HMAC-SHA256 签名）</summary>
      <p className="muted">
        Secret 从不出现在请求里：网关按原始请求重建规范串，交给 identity-service 用加密保存的 Secret 重算 HMAC；
        时间戳限制有效期，nonce 写入 Redis 防重放，body 哈希防篡改，scope 决定能否交易 / 提现。对应实现：
        <code>services/api-gateway/src/http/api-key-signature.ts</code>、
        <code>services/identity-service/src/domain/api-key-secret.ts</code>
      </p>
      <pre>
        <code>{SIGNING_EXAMPLE}</code>
      </pre>
    </details>
  );
}
