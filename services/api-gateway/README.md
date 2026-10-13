# api-gateway

职责:

- 作为学习型 Web3 CEX MVP 的客户侧统一入口
- 负责 customer session / API Key 鉴权、签名校验、限流、幂等和账户归属校验
- 把前台请求收口到资金域和交易域接口之前

主链定位:

- 职责是把浏览器用户和程序化交易的入口统一到一层可解释、可观察的网关里
- 当前学习路径优先看 `auth / balances / withdrawals / orders / realtime`
- 如果目标是解释“用户请求如何进入系统、为什么 session 和 API Key 要并存”，这里就是入口证据点

当前实现:

- `POST /api/v1/gateway/auth/register`
- `POST /api/v1/gateway/auth/sessions`
- `GET /api/v1/gateway/auth/me`
- `POST /api/v1/gateway/auth/logout`
- `POST /api/v1/gateway/auth/api-keys`
- `GET /api/v1/gateway/auth/api-keys`
- `POST /api/v1/gateway/auth/api-keys/{apiKeyId}/revoke`
- `GET /api/v1/gateway/auth/two-factor`（以下 2FA / KYC 接口均为 session-only，API Key 无法调用）
- `POST /api/v1/gateway/auth/two-factor/enroll`（返回 `secret` + `otpauthUri`，前台本地渲染二维码）
- `POST /api/v1/gateway/auth/two-factor/enable`（`{ code }`，响应带只显示一次的 `recoveryCodes`）
- `POST /api/v1/gateway/auth/two-factor/disable`（`{ code }`，当前动态码或恢复码）
- `POST /api/v1/gateway/auth/two-factor/recovery-codes`（`{ code }`，重新生成恢复码）
- `GET /api/v1/gateway/auth/kyc`（当前等级与最近申请）
- `POST /api/v1/gateway/auth/kyc/requests`（`{ requestedTier: "L1" | "L2", fullName, idNumber }`，演示字段）
- `GET /api/v1/gateway/withdrawals/limits`（等级、各币种限额、今日已用、双人复核阈值、冷却期；session 或带 `read` 的 API Key）
- `GET /api/v1/gateway/accounts/spot`（返回当前用户现货账户；首次调用时以确定性 ID 幂等开户，注册时也会自动开户）
- `GET /api/v1/gateway/balances`
- `POST /api/v1/gateway/deposit-addresses`
- `GET /api/v1/gateway/deposit-addresses`
- `GET /api/v1/gateway/deposits`
- `GET /api/v1/gateway/deposits/{depositId}`
- `GET /api/v1/gateway/withdrawals`
- `GET /api/v1/gateway/withdrawals/{withdrawalId}`
- `POST /api/v1/gateway/withdrawals/validate`
- `POST /api/v1/gateway/withdrawals/request`
- `GET /api/v1/gateway/withdrawal-address-book`
- `POST /api/v1/gateway/withdrawal-address-book`
- `GET /api/v1/gateway/notifications`（返回 `readAt` 已读标记；可按 `readState=read|unread`、`depositId` 过滤）
- `GET /api/v1/gateway/notifications/unread-count`（通知中心铃铛未读数）
- `POST /api/v1/gateway/notifications/{notificationId}/read`、`POST /api/v1/gateway/notifications/read-all`（标记已读，API Key 只需 `read` scope；只作用于调用者自己的通知，别人的 id 返回 404）
- `GET /api/v1/gateway/ledger/entries?assetCode=&category=&businessType=&includeLockEvents=&from=&to=&limit=&offset=`（资金流水；账户固定为调用者自己的现货账户，请求里不接受 accountId）
- `POST /api/v1/gateway/orders`（可选 `postOnly`、`stpMode`，止损单 `type=stop_limit|stop_market` + `triggerPrice`；网关在 `src/application/order-options.ts` 做格式校验与归一化，业务规则由 risk-service 校验）
- `GET /api/v1/gateway/orders`
- `GET /api/v1/gateway/orders/{orderId}`
- `POST /api/v1/gateway/orders/{orderId}/cancel`
- `GET /api/v1/gateway/trades`
- `GET /api/v1/gateway/trades/{tradeId}/journals`：成交分录（T 型账户视图），只允许买方 / 卖方读取，对手方账户脱敏为「对手方」；脱敏与借贷平衡校验在 `src/domain/journal-view.ts`，分录读取复用 `LedgerGatewayClient.listJournalsWithEntries`
- `WS /api/v1/gateway/realtime`

认证方式:

- Session: `Authorization: Bearer <customer_session_token>`
- API Key:
- `X-API-Key`（公开的 keyId，`ak_…`）
- `X-API-Timestamp`
- `X-API-Nonce`
- `X-API-Signature`

支持幂等键的写接口:

- `POST /api/v1/gateway/auth/api-keys`
- `POST /api/v1/gateway/deposit-addresses`
- `POST /api/v1/gateway/withdrawals/request`
- `POST /api/v1/gateway/withdrawal-address-book`
- `POST /api/v1/gateway/orders`

请求头:

- `Idempotency-Key`

签名串格式:

```text
{METHOD}\n{ORIGINAL_URL_WITH_QUERY}\n{TIMESTAMP_MS}\n{NONCE}\n{SHA256_HEX_OF_RAW_BODY}
```

签名算法:

- `HMAC-SHA256`，key 为创建时只显示一次的 `secret`（`sk_…`）；请求里只带公开的 `keyId`（`ak_…`）
- gateway 不持有 secret：它从原始请求重建签名串，调用 identity `POST /internal/api-keys/verify-signature` 校验；identity 用 AES-256-GCM 加密保存 secret（`IDENTITY_API_KEY_ENCRYPTION_KEY`）
- 时间戳默认允许漂移 `5` 分钟；`X-API-Nonce`（8–64 位 `[A-Za-z0-9_-]`）在签名通过后写入 Redis（`SET NX`），重复使用返回 `401 API_KEY_NONCE_REPLAYED`
- scope：`read`（必有）/ `trade`（默认）/ `withdraw`（需显式勾选）。GET 需要 `read`，下单撤单需要 `trade`，提现与地址簿写入需要 `withdraw`；不足时返回 `403 API_KEY_SCOPE_DENIED`

运行:

```bash
pnpm --filter @web3-cex/api-gateway start
```

默认端口:

- `3007`

依赖:

- `identity-service`
- `ledger-service`
- `wallet-service`
- `order-service`

私有 WebSocket:

- 路径: `ws://127.0.0.1:3007/api/v1/gateway/realtime`
- 支持 `token` 或 `apiKey(keyId) + timestamp + nonce + signature` 认证
- 握手校验 `Origin`（`GATEWAY_WS_ALLOWED_ORIGINS`，逗号分隔，默认 `http://127.0.0.1:3013,http://localhost:3013`，`*` 关闭校验）；不带 Origin 的非浏览器客户端（API Key 机器人）放行，其他站点返回 `403`
- 每个连接消息限流：`GATEWAY_WS_MESSAGE_LIMIT`（默认 30）/ `GATEWAY_WS_MESSAGE_WINDOW_MS`（默认 10000）；超限返回错误消息，超过 2 倍阈值以 `4008` 断开；单条消息最大 64KB
- 会话到期时以 `4001` 断开；每 `GATEWAY_WS_REAUTH_INTERVAL_MS`（默认 60000）重新校验 session token，退出登录或账户被冻结后以 `4003` 断开。trader-web 收到 4001/4003 不再重连并提示重新登录
- 支持频道:
  - `orders`
  - `trades`
  - `notifications`
  - `balances`
  - `deposits`
  - `withdrawals`
  - `positions`
  - `account_events`
- 支持消息:
  - `auth`
  - `subscribe`
  - `unsubscribe`
  - `snapshot`
  - `ping`
  - `resume`
- 当前实现方式:
  - `orders` / `trades` 由 Redis 交易事件驱动推送
  - `notifications` 由 `wallet-service` Redis 事件驱动推送（提现各状态 + `deposit.credited`）；已读标记变化不推送，客户端在快照 / 重连后重新拉 `unread-count`
  - `balances` 会在交易事件和钱包通知事件到达时推送最新余额差量
  - `deposits` / `withdrawals` 会在钱包事件到达时推送最新状态差量
  - `positions` 会在交易事件和钱包事件到达时推送市场级仓位快照差量
  - `account_events` 会把余额 / 充值 / 提币 / 通知统一收敛成账户事件 envelope
  - replayable 消息带 `sequence`，支持缓冲区内 `resume` 和过期后的 `resync_required + snapshot`

当前限制:

- 公共行情由独立的 `market-data-service` 提供，不在 `api-gateway` 内承载
- 不包含更完整的 replay / compensation 自动化
- `account_events` 目前只覆盖账户域事件，不承载订单 / 成交 / 仓位的统一 envelope
- 用户资金域仍依赖内部 `ledgerAccountId`，由 gateway 做账户归属校验，避免跨账户调用

当前运行说明:

- 默认使用 Redis 做固定窗口限流和幂等键存储
- 默认只监听 `127.0.0.1`（`GATEWAY_BIND_HOST`），启动日志打印实际地址
- 匿名限流、幂等作用域、请求审计和登录会话 IP 默认取 socket 对端地址；只有设置 `GATEWAY_TRUST_PROXY=true` 时才信任 `X-Forwarded-For` 第一段（`src/http/client-ip.ts`）
- 会输出结构化请求审计日志到应用日志
- 如果 Redis 不可用，可通过 `GATEWAY_RATE_LIMIT_STORE=memory` 和 `GATEWAY_IDEMPOTENCY_STORE=memory` 回退到单实例内存模式
- 实时层环境变量 `GATEWAY_WS_PATH` / `GATEWAY_WS_SNAPSHOT_LIMIT` / `GATEWAY_WS_CACHE_SIZE` 见 [.env.example](.env.example)；`GATEWAY_WS_ALLOWED_ORIGINS`、`GATEWAY_WS_MESSAGE_*`、`GATEWAY_WS_REAUTH_INTERVAL_MS`、`GATEWAY_WS_REPLAY_BUFFER_SIZE`（默认 200）未写入示例文件，使用代码默认值

下单幂等键：`POST /orders` 接受 body 中的 `idempotencyKey` 或标准 `Idempotency-Key` 请求头，二者都缺失时返回 `400`。

延伸阅读:

- [03 账户、身份与安全](../../learning/03-account-identity-security.md)
- [02 系统架构](../../learning/02-system-architecture.md)
- [API 契约](../../docs/api-contracts.md)、[安全设计](../../docs/security.md)
