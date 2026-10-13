# API 契约

本文列出仓库中所有 HTTP / WebSocket / TCP 接口的当前契约，内容以各服务的 controller、DTO 和 guard 为准。字段级细节（完整请求体、响应体）请直接看对应服务的 `src/http/dto.ts` 与 `src/domain/types.ts`。

- 系统分层与调用关系见 [architecture.md](architecture.md)
- 领域对象与状态机见 [domain-model.md](domain-model.md)
- 事件（Redis / Kafka）契约见 [event-catalog.md](event-catalog.md)
- 账本内部设计见 [ledger-service-design.md](ledger-service-design.md)
- 认证、签名、CSRF 等安全设计见 [security.md](security.md)

---

## 1. 通用约定

### 1.1 服务、端口与路由前缀

| 组件 | 默认端口 | 路由前缀 | 面向 |
| --- | --- | --- | --- |
| `apps/trader-web`（Web Host / BFF） | 3013 | `/api/session`、`/api/gateway/*`、`/api/market/*`、`/api/demo/*`、WS `/api/realtime` | 浏览器 |
| `apps/ops-console`（BFF） | 3006 | `/api/v1/ops/*` | 运营浏览器 / 脚本 |
| `services/api-gateway` | 3007 | `/api/v1/gateway/*`、WS `/api/v1/gateway/realtime` | 用户端（经 trader-web 或 API key 直连） |
| `services/market-data-service` | 3012 | `/api/v1/market-data/*`、WS `/api/v1/market-data/ws` | 公开行情 |
| `services/ledger-service` | 3001 | `/api/v1/ledger/*` | 内部 |
| `services/wallet-service` | 3002 | `/api/v1/wallet/*` | 内部 |
| `services/blockchain-indexer` | 3003 | `/api/v1/indexer/*` | 内部 |
| `services/custody-adapter` | 3004 | `/api/v1/custody/*` | 内部 |
| `services/identity-service` | 3005 | `/api/v1/identity/*` | 内部 |
| `services/risk-service` | 3008 | `/api/v1/risk/*` | 内部 |
| `services/order-service` | 3009 | `/api/v1/orders/*`、`/api/v1/trades/*` | 内部 |
| `services/settlement-service` | 3010 | `/api/v1/settlement/*` | 内部 |
| `engines/matching-engine`（Rust） | 3011 | 原始 TCP，单行 JSON | 仅 order-service |

端口都可以用各自的 `PORT` 环境变量覆盖。

### 1.2 认证方式一览

| 方式 | 用在哪里 | 凭证 |
| --- | --- | --- |
| 用户浏览器 Cookie 会话 | trader-web | HttpOnly `tw_session` + 可读 `tw_csrf`；写请求需回带 `x-csrf-token` |
| 用户 Bearer 会话 | api-gateway | `Authorization: Bearer <session token>` |
| API key 签名 | api-gateway（REST 与私有 WS） | `X-API-Key` / `X-API-Timestamp` / `X-API-Nonce` / `X-API-Signature` |
| 运营会话 + TOTP | ops-console | 登录时必须带 TOTP；之后用 `ops_session` Cookie（+ `ops_csrf`）或 Bearer |
| 内部服务 HMAC | identity / ledger / wallet / order / risk / settlement | `x-internal-service-name` / `x-internal-service-timestamp` / `x-internal-service-signature` |
| 无认证 | market-data（公开）、blockchain-indexer、custody-adapter、matching-engine | 仅应在本地 / 内网可达 |

#### 用户浏览器 Cookie 会话（trader-web）

trader-web 是浏览器面对的唯一入口。登录时它代调 `POST /api/v1/gateway/auth/sessions`，把返回的 `token` 写进 Cookie，响应体里不再包含 token：

- `tw_session`：`HttpOnly; SameSite=Strict; Path=/`，有效期跟随会话 `expiresAt`
- `tw_csrf`：可读的随机值，前端在每个非 GET 请求里放进 `x-csrf-token` 头（double submit）
- 代理 `/api/gateway/*` 和私有 WebSocket 时，trader-web 把 Cookie 换成 `Authorization: Bearer <token>` 再转发；上游永远看不到 Cookie
- 显式带了 `Authorization: Bearer` 的调用方不做 CSRF 检查
- CSRF 校验失败返回 `403 {"code":"CSRF_TOKEN_INVALID"}`

#### 用户 Bearer 会话（api-gateway）

`POST /api/v1/gateway/auth/sessions` 返回的 `token` 放在 `Authorization: Bearer` 中使用。会话默认有效期 7 天（identity 的 `CUSTOMER_SESSION_TTL_HOURS`），每次请求都会向 identity 做一次会话内省，登出或冻结后立即失效。

#### API key 签名（api-gateway）

API key 只能在会话下创建（`POST /auth/api-keys`），返回的 `keyId`（`ak_...`）是公开标识，`secret`（`sk_...`）只在创建时返回一次。gateway 不持有 secret：它把规范化请求转交 identity，由 identity 重新计算 HMAC。

规范化请求串（各行以 `\n` 连接）：

```text
METHOD            大写，如 POST
URL               path + query，如 /api/v1/gateway/orders?x=1
TIMESTAMP         Unix 毫秒
NONCE             8-64 位 [A-Za-z0-9_-]
SHA256(body)      原始请求体的 hex 摘要，空体为空串的摘要
```

`X-API-Signature = hex(HMAC-SHA256(secret, 上面的串))`。

| 规则 | 说明 |
| --- | --- |
| 时间窗 | `|now - timestamp|` 不超过 `GATEWAY_API_KEY_MAX_DRIFT_MS`（默认 300000 ms），否则 `401 API_KEY_TIMESTAMP_EXPIRED` |
| Nonce | 签名通过后才登记，同一 `keyId` 下重复使用返回 `401 API_KEY_NONCE_REPLAYED` |
| 四个头 | 只给一部分返回 401；四个都不给且无 Bearer 返回 401 |
| 用户类型 | 只接受 customer 的 key，否则 `403 FORBIDDEN` |
| Scope | `read` / `trade` / `withdraw`，创建时默认 `read + trade`。路由未声明时 GET 需要 `read`，其他方法需要 `trade`；不满足返回 `403 API_KEY_SCOPE_DENIED` |
| 会话专用接口 | 标记为“会话”的接口拒绝 API key（`401`），例如 API key 管理、2FA、KYC |

客户端签名可以直接复用 `services/api-gateway/src/http/api-key-signature.ts` 中的 `createApiKeySignature`。

#### 运营会话 + TOTP（ops-console）

- `POST /api/v1/ops/auth/login` 提交 `email`、`password`、`twoFactorCode`
- identity 默认要求运营账号已启用 2FA（`OPS_REQUIRE_TWO_FACTOR` 不为 `false`），未启用返回 `403 OPS_TWO_FACTOR_REQUIRED`；登录时也可用一次性恢复码替代 TOTP
- 请求头带 `x-ops-session-mode: cookie` 时，ops-console 写入 `ops_session`（HttpOnly）和 `ops_csrf`（可读）两个 Cookie，响应体不含 token；否则直接返回 `token`，脚本用 `Authorization: Bearer` 调用
- Cookie 方式的非 GET 请求必须带 `x-csrf-token`（值等于 `ops_csrf`），否则 403
- 运营会话默认 12 小时（`OPS_SESSION_TTL_HOURS`）
- 每个接口声明所需权限，缺权限返回 `403 Ops session is missing permissions: ...`。角色与权限见第 5.4 节

#### 内部服务 HMAC

服务之间的调用都带三个头：

| 头 | 含义 |
| --- | --- |
| `x-internal-service-name` | 调用方名称，如 `api-gateway` |
| `x-internal-service-timestamp` | Unix 毫秒 |
| `x-internal-service-signature` | `hex(HMAC-SHA256(INTERNAL_SERVICE_AUTH_SECRET, 规范串))` |

规范串为 `callerName \n METHOD \n path(含 query) \n timestamp \n SHA256(body)`，实现见 `packages/domain` 的 `createInternalServiceAuthHeaders` / `verifyInternalServiceSignature`。

- 时间偏差默认不超过 30 s（`INTERNAL_SERVICE_AUTH_MAX_SKEW_MS`）
- 未配置 `INTERNAL_SERVICE_AUTH_SECRET` 时服务返回 503
- 每个服务有调用方白名单，可用 `INTERNAL_SERVICE_ALLOWED_CALLERS`（逗号分隔）覆盖：

| 被调服务 | 默认允许的调用方 |
| --- | --- |
| identity-service | `api-gateway`、`wallet-service`、`ops-console`、`demo-scripts` |
| ledger-service | `api-gateway`、`wallet-service`、`order-service`、`settlement-service`、`risk-service`、`ops-console`、`demo-scripts` |
| wallet-service | `api-gateway`、`blockchain-indexer`、`ops-console`、`demo-scripts` |
| order-service | `api-gateway`、`settlement-service`、`market-data-service`、`ops-console`、`demo-scripts` |
| risk-service | `order-service`、`ops-console`、`demo-scripts` |
| settlement-service | `order-service`、`ops-console`、`demo-scripts` |

### 1.3 幂等

| 层 | 机制 |
| --- | --- |
| api-gateway | 标记为“幂等”的写接口读取 `Idempotency-Key` 头。作用域为“当前主体（或匿名 IP）+ key”，请求指纹为 `METHOD + URL + SHA256(body)`，记录默认保留 1 小时（`GATEWAY_IDEMPOTENCY_TTL_MS`）。同 key 同指纹重放会返回第一次的状态码和响应体，并带 `x-idempotent-replay: true`；同 key 不同指纹返回 `409`；上一个同 key 请求还没完成也返回 `409`；处理失败时释放该 key。不带头时不做网关层幂等 |
| 下单 | `POST /orders` 必须有幂等键，可放请求体 `idempotencyKey` 或 `Idempotency-Key` 头（两者都缺返回 400）。order-service 按 `idempotencyKey` 去重，重复提交返回已存在的订单 |
| ledger | `POST /journals` 以 `idempotencyKey` 唯一，重复提交返回已存在的 journal；冻结以 `(referenceType, referenceId, accountId, assetCode)` 唯一 |
| wallet | 充值入账 journal 的幂等键为 `deposit:<depositId>` |
| settlement | 成交结算 journal 的幂等键为 `spot_trade:base:<tradeId>` / `spot_trade:quote:<tradeId>` |

网关层幂等接口：`POST /auth/api-keys`、`POST /deposit-addresses`、`POST /withdrawals/request`、`POST /withdrawal-address-book`、`POST /orders`。

### 1.4 错误格式

业务错误统一返回：

```json
{ "code": "INSUFFICIENT_AVAILABLE_BALANCE", "message": "Available balance is not enough to freeze requested amount" }
```

- HTTP 状态码按错误码映射（各服务的 `*-exception.filter.ts`），常见映射：参数 / 规则不满足 400，未认证 401，无权限或安全策略拦截 403，资源不存在 404，状态冲突或重复 409，上游失败 502
- api-gateway 对 Nest 内置异常（如缺少幂等键、429）只返回 `{ "message": "..." }`
- api-gateway 转发上游 4xx/5xx 时，若能解析出上游的 `code`，会原样透传；否则使用 `IDENTITY_UPSTREAM_FAILED` / `WALLET_UPSTREAM_FAILED` / `LEDGER_UPSTREAM_FAILED` / `ORDER_UPSTREAM_FAILED` 并保留上游状态码
- 打开 `OTEL_ENABLED=true` 时，api-gateway 的每个响应带 `x-trace-id`，可在 Jaeger 中检索

常见错误码：

| 来源 | 错误码 |
| --- | --- |
| api-gateway | `UNAUTHORIZED`、`SESSION_REQUIRED`、`INVALID_API_KEY`、`INVALID_API_KEY_NONCE`、`INVALID_API_KEY_TIMESTAMP`、`API_KEY_TIMESTAMP_EXPIRED`、`API_KEY_NONCE_REPLAYED`、`API_KEY_SCOPE_DENIED`、`ACCOUNT_FORBIDDEN`、`ACCOUNT_NOT_ACTIVE`、`RESOURCE_FORBIDDEN`、`TWO_FACTOR_CODE_REQUIRED`、`INVALID_STATEMENT_QUERY`、`INVALID_NOTIFICATION_ID` |
| identity | `INVALID_CREDENTIALS`、`USER_ALREADY_EXISTS`、`USER_NOT_ACTIVE`、`TWO_FACTOR_REQUIRED`、`OPS_TWO_FACTOR_REQUIRED`、`TWO_FACTOR_INVALID_CODE`、`TWO_FACTOR_CODE_REUSED`、`TWO_FACTOR_RECOVERY_CODE_INVALID`、`OPS_ACCESS_DENIED`、`KYC_REQUEST_PENDING`、`KYC_NOT_ALLOWED`、`API_KEY_NOT_FOUND`、`API_KEY_REVOKED`、`INVALID_API_KEY_SIGNATURE` |
| ledger | `ACCOUNT_NOT_FOUND`、`BALANCE_NOT_FOUND`、`INSUFFICIENT_AVAILABLE_BALANCE`、`JOURNAL_NOT_BALANCED`、`INVALID_AMOUNT`、`DUPLICATE_BALANCE_LOCK`、`BALANCE_LOCK_NOT_FOUND`、`INVALID_BALANCE_LOCK_STATE`、`SETTLEMENT_ACCOUNT_REQUIRED` |
| order / risk | `UNSUPPORTED_MARKET`、`MARKET_HALTED`、`MARKET_DELISTED`、`PRICE_REQUIRED`、`INVALID_ORDER_PRICE`、`INVALID_ORDER_QUANTITY`、`INVALID_STEP_ALIGNMENT`、`ORDER_MIN_QUANTITY_NOT_MET`、`PRICE_DEVIATION_TOO_HIGH`、`UNSUPPORTED_TIME_IN_FORCE`、`ORDER_NOT_FOUND`、`ORDER_NOT_CANCELLABLE` |
| wallet | `INVALID_AMOUNT`、`INVALID_DESTINATION_ADDRESS`、`WITHDRAWAL_AMOUNT_BELOW_MINIMUM`、`WITHDRAWAL_FEE_BELOW_MINIMUM`、`WITHDRAWAL_SINGLE_LIMIT_EXCEEDED`、`WITHDRAWAL_DAILY_LIMIT_EXCEEDED`、`WITHDRAWAL_2FA_REQUIRED`、`WITHDRAWAL_2FA_NOT_ENABLED`、`WITHDRAWAL_2FA_INVALID`、`WITHDRAWAL_ADDRESS_NOT_WHITELISTED`、`WITHDRAWAL_SECURITY_COOLDOWN`、`WITHDRAWAL_SAME_APPROVER`、`INVALID_WITHDRAWAL_STATE` |

风控拒绝（校验类错误）在订单落库前直接返回 HTTP 错误；撮合阶段无法成交的 IOC / FOK / 市价单则返回 `status: "rejected"` 的订单并附 `rejectedReason`。

### 1.5 限流

api-gateway 在认证之后执行固定窗口限流：

| 主体 | 限流键 | 默认额度 |
| --- | --- | --- |
| 匿名（公开接口） | 客户端 IP（取 `x-forwarded-for` 第一段） | 30 次 / 60 s（`GATEWAY_RATE_LIMIT_PUBLIC_MAX`） |
| 会话 / API key | `authType + userId + sessionId 或 apiKeyId` | 120 次 / 60 s（`GATEWAY_RATE_LIMIT_AUTHENTICATED_MAX`） |

窗口长度由 `GATEWAY_RATE_LIMIT_WINDOW_MS` 控制，存储默认 Redis（`GATEWAY_RATE_LIMIT_STORE=memory` 切内存）。每个响应带 `x-rate-limit-limit`、`x-rate-limit-remaining`、`x-rate-limit-reset`（ISO 时间），超限返回 `429`。私有 WebSocket 另有消息限流，见 2.8 节。

### 1.6 分页与金额

- 列表接口通常接受 `limit` / `offset`，返回 `{ items, total, limit, offset }`；ledger 默认 `limit=50`，上限 200
- 金额、价格、数量一律是十进制字符串（最多 18 位小数），不要用 JSON number
- 时间是 ISO-8601 字符串

---

## 2. 用户端 API（api-gateway）

基础路径 `/api/v1/gateway`。经 trader-web 访问时路径是 `/api/gateway/*`（去掉 `/api/v1/gateway` 前缀，由 BFF 补上）。

“认证”列取值：

- **公开**：无需凭证
- **会话**：只接受 Bearer 会话（经 trader-web 时即 Cookie 会话），拒绝 API key
- **会话/Key(scope)**：接受会话或 API key，括号里是 API key 需要的 scope

所有涉及 `accountId` / `ledgerAccountId` 的接口都会校验账户属于当前用户且状态为 `active`；按 ID 查询的资源（订单、成交、充值、提币）也会校验归属。

### 2.1 账号与安全

| 方法 | 路径 | 认证 | 幂等 | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/auth/register` | 公开 | | 注册用户（`email`、`password`、`displayName?`），同时确保现货账户，返回体含 `spotAccountId` |
| POST | `/auth/sessions` | 公开 | | 登录（`email`、`password`、`twoFactorCode?`），返回会话信息与 `token`；已开 2FA 但未带码返回 `403 TWO_FACTOR_REQUIRED` |
| GET | `/auth/me` | 会话/Key(read) | | 返回当前主体（`authType`、`userId`、`sessionId` 或 `apiKeyId`、`apiKeyScopes` 等） |
| POST | `/auth/logout` | 会话 | | 撤销当前会话 |
| POST | `/auth/api-keys` | 会话 | 是 | 创建 API key（`label`、`scopes?`、`expiresAt?`），`secret` 仅此一次返回 |
| GET | `/auth/api-keys` | 会话 | | 列出 API key（不含 secret） |
| POST | `/auth/api-keys/:apiKeyId/revoke` | 会话 | | 撤销 API key |
| GET | `/auth/two-factor` | 会话 | | 2FA 状态 |
| POST | `/auth/two-factor/enroll` | 会话 | | 生成待绑定的 TOTP 密钥与 `otpauthUri` |
| POST | `/auth/two-factor/enable` | 会话 | | 用 `code` 确认绑定，返回 `recoveryCodes`（只显示一次） |
| POST | `/auth/two-factor/disable` | 会话 | | 关闭 2FA，`code` 可以是 TOTP 或恢复码 |
| POST | `/auth/two-factor/recovery-codes` | 会话 | | 用 `code` 重新生成恢复码 |
| GET | `/auth/kyc` | 会话 | | KYC 档案与当前等级（演示数据） |
| POST | `/auth/kyc/requests` | 会话 | | 提交 KYC 申请（`requestedTier?: L1/L2`、`fullName?`、`idNumber?`，证件号只保留后 4 位；不要填真实信息） |

`enable` / `disable` / `recovery-codes` 缺少 `code` 时网关直接返回 `400 TWO_FACTOR_CODE_REQUIRED`。

登录示例：

```http
POST /api/v1/gateway/auth/sessions
Content-Type: application/json

{ "email": "demo-trader@example.com", "password": "DemoTraderPass123!", "twoFactorCode": "123456" }
```

```json
{
  "token": "<session token>",
  "sessionId": "8b1f…",
  "userId": "2c4e…",
  "email": "demo-trader@example.com",
  "status": "active",
  "userType": "customer",
  "scope": "customer_web",
  "roles": [],
  "permissions": [],
  "createdAt": "…",
  "expiresAt": "…",
  "lastSeenAt": "…",
  "active": true
}
```

创建 API key 的响应（节选）：

```json
{
  "apiKeyId": "5d0c…",
  "label": "bot",
  "keyId": "ak_3f9a…",
  "keyPrefix": "ak_3f9a…",
  "scopes": ["read", "trade"],
  "secret": "sk_…",
  "status": "active"
}
```

### 2.2 账户、余额与资金流水

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/accounts/spot` | 会话/Key(read) | 返回当前用户的现货账户 `{ accountId, accountType: "spot" }`，首次调用时创建（账户 ID 由 userId 稳定派生） |
| GET | `/balances` | 会话/Key(read) | 当前用户余额，过滤：`accountId`、`assetCode`、`accountType`、`accountStatus`、`limit`、`offset`。每行含 `available`、`locked`、`total` |
| GET | `/ledger/entries` | 会话/Key(read) | 现货账户的资金流水（见下） |
| GET | `/withdrawals/limits` | 会话/Key(read) | 当前 KYC 等级下各资产的单笔 / 每日提币额度与当日已用额度 |
| GET | `/proof-of-reserves` | 会话/Key(read) | 最新储备金证明快照 + 当前用户自己的 Merkle 叶子与路径（见下） |

`GET /ledger/entries` 查询参数：

| 参数 | 说明 |
| --- | --- |
| `assetCode` | 资产过滤 |
| `category` | `deposit` / `withdrawal` / `trade` / `adjustment` / `fee`（`fee` 表示带手续费的成交行），其他值返回 `400 INVALID_STATEMENT_QUERY` |
| `businessType` | 按原始 journal `businessType` 过滤（只作用于分录行） |
| `includeLockEvents` | 默认 `true`；`false` 隐藏冻结 / 解冻行 |
| `from` / `to` | ISO 时间，`from` 含、`to` 不含 |
| `limit` / `offset` | `limit` 默认 50，范围 1–200 |

响应：

```json
{
  "accountId": "…",
  "items": [
    {
      "lineId": "entry:…",
      "source": "entry",
      "occurredAt": "…",
      "assetCode": "USDT",
      "category": "trade",
      "action": "trade_credit",
      "amount": "199.8",
      "totalDelta": "199.8",
      "availableDelta": "199.8",
      "lockedDelta": "0",
      "balanceAfter": { "total": "1199.8", "available": "1199.8", "locked": "0" },
      "businessType": "spot_trade_settlement_quote",
      "businessId": "<tradeId>",
      "referenceType": "spot_trade",
      "referenceId": "<tradeId>",
      "feeAmount": "0.2",
      "feeAssetCode": "USDT"
    }
  ],
  "total": 12,
  "limit": 50,
  "offset": 0,
  "balanceDerivable": { "USDT": true, "ETH": true }
}
```

`balanceDerivable[asset]` 为 `false` 表示该资产的历史无法完整解释当前快照，此时不返回 `balanceAfter`。行的计算规则见 [ledger-service-design.md](ledger-service-design.md#9-资金流水statement)。

`GET /proof-of-reserves`：网关用当前登录用户的 `userId` 调 wallet-service，用户无法查询别人的叶子。还没有快照时返回 `{ "available": false }`；有快照时：

```json
{
  "available": true,
  "snapshot": {
    "snapshotId": "…",
    "merkleRoot": "a285ff…",
    "leafCount": 4,
    "treeDepth": 2,
    "createdAt": "…",
    "assets": [
      { "assetCode": "USDT", "reserves": "1250000", "liabilities": "1040000", "withdrawalsInFlight": "0",
        "netLiabilities": "1040000", "hot": "125000", "cold": "1124975", "depositAddresses": "25",
        "internalInTransit": "0", "reserveRatio": "1.2019", "status": "covered" }
    ],
    "format": { "hashAlgorithm": "SHA-256", "userHash": "…", "leaf": "…", "node": "…" }
  },
  "included": true,
  "leaf": {
    "userId": "<自己的 userId>",
    "nonce": "9f1c…",
    "userHash": "…",
    "balances": { "ETH": "5", "USDT": "25000" },
    "leafIndex": 2,
    "leafHash": "…",
    "message": "por-leaf:v1|<userHash>|ETH=5,USDT=25000"
  },
  "proof": [{ "position": "left", "hash": "…" }, { "position": "right", "hash": "…" }]
}
```

验证：`userHash = SHA-256("por-user:v1|" + userId + "|" + nonce)`，`leafHash = SHA-256("por-leaf:v1|" + userHash + "|" + 按币种排序的 "ASSET=amount" 逗号拼接)`，然后对 `proof` 每一步计算 `SHA-256("por-node:v1|" + 左 + "|" + 右)`（`position` 是兄弟节点所在的一侧），最终结果应等于 `merkleRoot`。快照之后才产生余额的用户 `included=false`。

### 2.3 充值

| 方法 | 路径 | 认证 | 幂等 | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/deposit-addresses` | 会话/Key(read) | 是 | 为 `ledgerAccountId` + `assetCode` + `network` 分配充值地址 |
| GET | `/deposit-addresses` | 会话/Key(read) | | 过滤：`ledgerAccountId`、`assetCode`、`network`、`status`、`address`、分页 |
| GET | `/deposits` | 会话/Key(read) | | 过滤：`ledgerAccountId`、`assetCode`、`network`、`status`、`txHash`、`address`、分页 |
| GET | `/deposits/:depositId` | 会话/Key(read) | | 充值详情 |

充值状态：`detected` → `confirming` → `confirmed` → `credited`（或 `failed`）。

### 2.4 提币与地址簿

| 方法 | 路径 | 认证 | 幂等 | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/withdrawals/validate` | 会话/Key(withdraw) | | 只做规则预检，不冻结资金，也不消耗 2FA 验证码；返回 `appliedRules` |
| POST | `/withdrawals/request` | 会话/Key(withdraw) | 是 | 发起提币：校验通过后冻结 `amount + fee` 并进入审核 |
| GET | `/withdrawals` | 会话/Key(read) | | 过滤：`ledgerAccountId`、`assetCode`、`network`、`status`、`reviewStatus`、`txHash`、`toAddress`、分页 |
| GET | `/withdrawals/:withdrawalId` | 会话/Key(read) | | 提币详情 |
| GET | `/withdrawal-address-book` | 会话/Key(read) | | 过滤：`network`、`address`、`isWhitelisted`、分页 |
| POST | `/withdrawal-address-book` | 会话/Key(withdraw) | 是 | 新增地址（`network`、`address`、`label`、`isWhitelisted?`） |

提币请求体：

```json
{
  "ledgerAccountId": "…",
  "assetCode": "ETH",
  "network": "ethereum",
  "toAddress": "0x…",
  "amount": "0.5",
  "fee": "0.001",
  "twoFactorCode": "123456",
  "metadata": {}
}
```

`network` 取值以 `config/markets.json` 中资产的 `networks` 为准（默认本地链对应 `ethereum`）。wallet 的校验顺序：金额与地址格式 → 安全冷却期（2FA 变更后，`WITHDRAWAL_SECURITY_COOLDOWN`）→ 平台要求 2FA 但用户未开启（`WITHDRAWAL_2FA_NOT_ENABLED`）→ 最小金额 / 最小手续费 → 白名单（开启时）→ KYC 等级对应的单笔 / 每日额度 → 最后才校验 2FA 码。用户只要开启了 2FA，每笔提币都需要 `twoFactorCode`。

提币状态：`requested` → `reviewing` → `approved` → `broadcasted` → `confirmed`（或 `failed`）。超过双人复核阈值的提币需要两名不同的审核人批准。

### 2.5 通知

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/notifications` | 会话/Key(read) | 过滤：`withdrawalId`、`depositId`、`eventType`、`status`、`channel`、`readState`（`read` / `unread`）、分页 |
| GET | `/notifications/unread-count` | 会话/Key(read) | 未读数 |
| POST | `/notifications/read-all` | 会话/Key(read) | 全部标为已读 |
| POST | `/notifications/:notificationId/read` | 会话/Key(read) | 单条标为已读 |

### 2.6 现货交易

| 方法 | 路径 | 认证 | 幂等 | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/orders` | 会话/Key(trade) | 是（必需） | 下单 |
| GET | `/orders` | 会话/Key(read) | | 过滤：`accountId`、`market`、`status`、分页 |
| GET | `/orders/:orderId` | 会话/Key(read) | | 订单详情 |
| POST | `/orders/:orderId/cancel` | 会话/Key(trade) | | 撤单，释放剩余冻结 |
| GET | `/trades` | 会话/Key(read) | | 我的成交，过滤：`market`、`orderId`、分页 |
| GET | `/trades/:tradeId/journals` | 会话/Key(read) | | 该成交产生的账本 journal 的脱敏视图：自己的账户显示为本人现货账户，其他用户显示为对手方，平台账户显示可读名称，不暴露对方的账户 / 用户 / 订单 ID |

下单示例：

```http
POST /api/v1/gateway/orders
Authorization: Bearer <token>
Idempotency-Key: 7f0e2a1c-buy-001
Content-Type: application/json

{
  "accountId": "<spotAccountId>",
  "market": "ETH/USDT",
  "side": "buy",
  "type": "limit",
  "timeInForce": "gtc",
  "price": "2000",
  "quantity": "0.1"
}
```

```json
{
  "orderId": "…",
  "idempotencyKey": "7f0e2a1c-buy-001",
  "traceId": "spot_order:…",
  "userId": "…",
  "accountId": "…",
  "market": "ETH/USDT",
  "side": "buy",
  "type": "limit",
  "timeInForce": "gtc",
  "price": "2000",
  "quantity": "0.1",
  "filledQuantity": "0",
  "restingQuantity": "0.1",
  "status": "accepted",
  "lockAssetCode": "USDT",
  "lockAmount": "200",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `type`：`limit` / `market`；`timeInForce`：`gtc` / `ioc` / `fok`；`limit` 必须带 `price`
- 订单状态：`pending_risk`、`accepted`、`partially_filled`、`filled`、`cancelled`、`rejected`、`recovery_pending`（成交后续步骤失败，等待恢复任务）
- 价格、数量需对齐市场的 `priceStep` / `quantityStep`，并满足最小数量与价格偏离限制

### 2.7 用 API key 调用的完整示例

```js
import { createHash, createHmac, randomUUID } from "node:crypto";

const body = JSON.stringify({ accountId, market: "ETH/USDT", side: "buy", type: "limit", price: "2000", quantity: "0.1" });
const url = "/api/v1/gateway/orders";
const ts = String(Date.now());
const nonce = randomUUID().replaceAll("-", "");
const canonical = ["POST", url, ts, nonce, createHash("sha256").update(body).digest("hex")].join("\n");
const signature = createHmac("sha256", secret).update(canonical).digest("hex");

await fetch(`http://127.0.0.1:3007${url}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": `bot-${ts}`,
    "x-api-key": keyId,
    "x-api-timestamp": ts,
    "x-api-nonce": nonce,
    "x-api-signature": signature
  },
  body
});
```

签名用的 body 必须与实际发送的字节完全一致。

### 2.8 私有 WebSocket

- 地址：`ws://127.0.0.1:3007/api/v1/gateway/realtime`（`GATEWAY_WS_PATH`）；浏览器通过 trader-web 的同源 `/api/realtime` 连接
- Origin 校验：握手时检查 `GATEWAY_WS_ALLOWED_ORIGINS`，不允许的 Origin 直接拒绝
- 单帧上限 64 KiB

**认证**（任选其一）：

1. 握手带 `Authorization: Bearer <token>`（trader-web 代理就是这样做的）
2. 握手 query：`?token=` 或 `?apiKey=&timestamp=&nonce=&signature=`
3. 连接后发送 `{"type":"auth","token":"…"}` 或 `{"type":"auth","apiKey":"…","timestamp":"…","nonce":"…","signature":"…"}`

API key 的 WS 签名固定按 `GET` + WS 路径（`/api/v1/gateway/realtime`）+ 空 body 计算。

**客户端消息**：

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `auth` | 见上 | 认证 |
| `subscribe` / `unsubscribe` | `channels[]`、`market?` | 订阅后立即推送快照 |
| `snapshot` | `channels?`、`market?` | 主动拉快照 |
| `resume` | `lastSequence?`、`channels?`、`market?` | 断线重连后补发 |
| `ping` | | 心跳 |

频道：`orders`、`trades`、`notifications`、`balances`、`deposits`、`withdrawals`、`positions`、`account_events`。

**服务端消息**：

| `type` | 说明 |
| --- | --- |
| `ready` | 连接建立，含 `connectionId`、`resumeSupported` |
| `authenticated` | 认证成功，含 `authType`、`userId`、`latestSequence` |
| `subscribed` / `unsubscribed` | 订阅变更确认 |
| `snapshot` / `event` | `{ type, channel, sequence, items, sentAt }`，`sequence` 全局递增 |
| `resumed` | `mode: "replay"`（按序补发了 `replayedCount` 条）或 `mode: "snapshot"` |
| `resync_required` | `lastSequence` 已超出回放缓冲（每用户默认 200 帧，`GATEWAY_WS_REPLAY_BUFFER_SIZE`），随后推送全量快照 |
| `pong` | 心跳响应 |
| `error` | 错误说明 |

**关闭码**：

| 关闭码 | 原因 |
| --- | --- |
| 4001 | 会话到期 |
| 4003 | 会话被撤销（每 60 s 重新内省一次，`GATEWAY_WS_REAUTH_INTERVAL_MS`，可捕获登出 / 冻结） |
| 4008 | 消息过多（默认 10 s 内 30 条，`GATEWAY_WS_MESSAGE_LIMIT` / `GATEWAY_WS_MESSAGE_WINDOW_MS`） |

推送来源是 Redis 频道 `web3-cex:trading.events` 与 `web3-cex:wallet.notifications`，事件内容见 [event-catalog.md](event-catalog.md)。

---

## 3. trader-web BFF 路由

trader-web 本身也暴露少量接口，其余请求按前缀代理：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| GET | `/api/config` | 前端运行时配置（市场、资产、WS 地址、demo 开关等） |
| POST | `/api/session` | 登录：代调 gateway `/auth/sessions`，写入 `tw_session` / `tw_csrf`，返回不含 token 的会话信息（201） |
| GET | `/api/session` | 当前会话（代调 `/auth/me`）；无 Cookie 返回 `401 NO_SESSION`，上游 401 时清除 Cookie |
| POST | `/api/session/logout` | 撤销会话并清除 Cookie，返回 `{ revoked }`；需要 CSRF |
| * | `/api/gateway/*` | 代理到 `api-gateway /api/v1/gateway/*`，Cookie 转 Bearer，写请求需要 CSRF |
| GET | `/api/market/*` | 代理到 `market-data-service /api/v1/market-data/*` |
| GET/POST | `/api/demo/status`、`/api/demo/faucet`、`/api/demo/faucet/:id` | 代理到 demo-simulator（默认 `http://127.0.0.1:3014`），仅 `TRADER_WEB_DEMO_MODE` 不为 `false` 时开放；其他 demo 路由返回 `404 DEMO_ROUTE_NOT_FOUND`，模拟器未运行返回 `503 DEMO_SIMULATOR_UNAVAILABLE` |
| WS | `/api/realtime` | 私有 WebSocket 代理，无 Cookie 返回 401 |

公开行情 WebSocket 由浏览器直接连接 market-data-service。

---

## 4. 行情 API（market-data-service）

公开接口，无需认证。经 trader-web 访问时路径为 `/api/market/*`。

### 4.1 REST

| 方法 | 路径 | 参数 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/market-data/tickers` | | 所有已配置市场的 24h 行情 |
| GET | `/api/v1/market-data/ticker` | `market` | 单个市场 24h 行情 |
| GET | `/api/v1/market-data/depth` | `market`、`limit`（默认 20，1–200） | 买卖盘聚合深度 |
| GET | `/api/v1/market-data/trades` | `market`、`limit`（默认 50，1–200） | 最近成交 |
| GET | `/api/v1/market-data/klines` | `market`、`interval`（`1m`/`5m`/`15m`/`1h`/`4h`/`1d`/`1w`，默认 `1m`）、`limit`（默认 200） | K 线 |
| GET | `/api/v1/market-data/analytics` | `market` | 1h / 4h / 1d / 1w 区间统计 |

`market` 使用 `ETH/USDT` 形式，查询串中需要 URL 编码（`ETH%2FUSDT`）。不支持的市场会报错。

```json
// GET /api/v1/market-data/ticker?market=ETH%2FUSDT
{
  "market": "ETH/USDT",
  "lastPrice": "2000",
  "openPrice24h": "1980",
  "highPrice24h": "2010",
  "lowPrice24h": "1975",
  "priceChange24h": "20",
  "volume24h": "12.5",
  "quoteVolume24h": "24950",
  "tradeCount24h": 87,
  "updatedAt": "…"
}
```

深度：`{ market, bids: [{ price, quantity, orderCount }], asks: [...], updatedAt }`。

### 4.2 WebSocket

- 地址：`ws://127.0.0.1:3012/api/v1/market-data/ws`（`MARKET_DATA_WS_PATH`），无需认证
- 客户端消息：`subscribe` / `unsubscribe` / `snapshot`（字段 `market`、`channels?`，省略 `channels` 表示全部），以及 `ping`
- 频道：`ticker`、`depth`、`trades`
- 第一次订阅必须带 `market`，否则返回 `{"type":"error","code":"MARKET_REQUIRED"}`；非 JSON 消息返回 `INVALID_MESSAGE`
- 服务端消息：`ready`、`snapshot` / `event`（`{ type, channel, market, item | items, sentAt }`，`ticker` / `depth` 用 `item`，`trades` 用 `items`）、`pong`、`error`
- 收到对应市场的成交事件后，向订阅该市场的连接重推已订阅频道

```json
{ "type": "subscribe", "market": "ETH/USDT", "channels": ["ticker", "depth", "trades"] }
```

---

## 5. 运营后台 API（ops-console）

基础路径 `/api/v1/ops`，认证方式见 1.2 节。除登录外，所有接口都需要运营会话，下表“权限”列为所需权限。运营写操作通过 `runAuditedAction` 记入运营操作审计日志（`GET /audit-logs/actions` 可查）。

### 5.1 会话、用户与市场

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/login` | 无 | 登录（`email`、`password`、`twoFactorCode`）；带 `x-ops-session-mode: cookie` 时写 Cookie |
| GET | `/auth/me` | 会话 | 当前运营会话（`roles`、`permissions`） |
| POST | `/auth/logout` | 会话 | 撤销会话并清 Cookie |
| GET | `/dashboard` | `ops.dashboard.read` | 首页汇总（`network`、`reviewQueueLimit`、`notificationsLimit`） |
| GET | `/modules` | `ops.dashboard.read` | 各模块健康 / 摘要 |
| GET | `/business-trace` | `ops.dashboard.read` | 按订单 / 成交 / 充值 / 提币等 ID 串联业务链路 |
| GET | `/market-config` | `ops.dashboard.read` | `config/markets.json` 中的市场与资产（下拉框用） |
| GET | `/markets` | `ops.markets.read` | 市场及当前状态 |
| POST | `/markets/:market/status` | `ops.markets.manage` | 设置市场状态（`status: listed / halted`、`reason?`） |
| GET | `/users` | `ops.users.read` | 用户搜索（`userId`、`email`、`status`、`userType`、`role`、`search`、分页） |
| POST | `/users/:userId/freeze` | `ops.users.freeze` | 冻结用户（`reason?`） |
| POST | `/users/:userId/unfreeze` | `ops.users.freeze` | 解冻用户 |
| GET | `/users/:userId/kyc` | `ops.users.read` | 用户 KYC 档案 |
| POST | `/users/:userId/kyc-tier` | `ops.users.manage` | 直接设置 KYC 等级（`tier`、`reason?`） |
| GET | `/kyc/requests` | `ops.users.read` | KYC 申请列表（`status: pending / approved / rejected`） |
| POST | `/kyc/requests/:requestId/approve` | `ops.users.manage` | 批准（`tier?`、`note?`） |
| POST | `/kyc/requests/:requestId/reject` | `ops.users.manage` | 拒绝（`reason?`） |

### 5.2 资产、充值、提币与通知

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/balances` | `ops.assets.read` | 账本余额搜索 |
| GET | `/deposits` | `ops.deposits.read` | 充值搜索 |
| GET | `/withdrawals` | `ops.withdrawals.read` | 提币搜索 |
| GET | `/withdrawals/review-queue` | `ops.withdrawals.read` | 待审核队列 |
| GET | `/withdrawals/:withdrawalId` | `ops.withdrawals.read` | 提币详情 |
| GET | `/withdrawals/:withdrawalId/audit-logs` | `ops.withdrawals.read` | 单笔提币审计日志 |
| POST | `/withdrawals/:withdrawalId/approve` | `ops.withdrawals.review` | 批准（`note?`），审核人取自当前会话；双人复核时同一人不能批两次（`409 WITHDRAWAL_SAME_APPROVER`） |
| POST | `/withdrawals/:withdrawalId/reject` | `ops.withdrawals.review` | 拒绝（`reason?`），释放冻结 |
| POST | `/withdrawal-batches/approve` | `ops.withdrawals.batch_review` | 批量批准（`withdrawalIds[]`、`note?`） |
| POST | `/withdrawal-batches/reject` | `ops.withdrawals.batch_review` | 批量拒绝（`withdrawalIds[]`、`reason?`） |
| POST | `/withdrawals/reconcile-stale` | `ops.notifications.manage` | 处理长时间停留在广播中的提币 |
| GET | `/withdrawal-address-book` | `ops.address_book.read` | 地址簿搜索 |
| POST | `/withdrawal-address-book/:addressBookId/whitelist` | `ops.address_book.manage` | 加入白名单 |
| POST | `/withdrawal-address-book/:addressBookId/unwhitelist` | `ops.address_book.manage` | 移出白名单 |
| GET | `/notifications` | `ops.notifications.read` | 通知列表 |
| POST | `/notifications/deliver` | `ops.notifications.manage` | 投递待发送通知（`limit?`） |

### 5.3 账本、交易、链上、托管与告警

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/ledger/overview` | `ops.ledger.read` | 账本运维总览（outbox、冻结、对账、告警） |
| GET | `/ledger/reconciliation` | `ops.ledger.read` | 余额对账报告 |
| POST | `/ledger/reconciliation/run` | `ops.ledger.execute` | 手动执行对账 |
| GET | `/ledger/replay` | `ops.ledger.read` | 单账户单资产回放（`accountId`、`assetCode`） |
| POST | `/ledger/replay/run` | `ops.ledger.execute` | 手动执行回放 |
| POST | `/ledger/outbox/drain` | `ops.ledger.execute` | 重排死信并发布积压 outbox |
| GET | `/spot/orders` | `ops.assets.read` | 订单搜索 |
| GET | `/spot/trades` | `ops.assets.read` | 成交搜索 |
| GET | `/spot/settlements` | `ops.assets.read` | 结算记录 |
| GET | `/spot/settlements/report` | `ops.assets.read` | 结算汇总 |
| GET | `/spot/settlements/recovery-jobs` | `ops.assets.read` | 结算恢复任务 |
| GET | `/spot/settlements/recovery-governance` | `ops.assets.read` | 结算恢复治理报告 |
| GET | `/spot/settlements/automation-executions` | `ops.assets.read` | 结算自动化执行记录 |
| POST | `/spot/settlements/recovery-jobs/process` | `ops.ledger.execute` | 处理结算恢复任务 |
| POST | `/spot/settlements/:tradeId/recover` | `ops.ledger.execute` | 恢复单笔成交结算 |
| GET | `/spot/ops/overview` | `ops.assets.read` | 交易运维总览 |
| GET | `/spot/ops/anomalies` | `ops.assets.read` | 订单 / 撮合异常 |
| GET | `/spot/ops/recovery-metrics` | `ops.assets.read` | 订单恢复指标 |
| GET | `/spot/ops/recovery-jobs` | `ops.assets.read` | 订单恢复任务 |
| GET | `/spot/ops/recovery-governance` | `ops.assets.read` | 订单恢复治理报告 |
| GET | `/spot/ops/dead-letter-jobs` | `ops.assets.read` | 死信任务 |
| GET | `/spot/ops/dead-letter-report` | `ops.assets.read` | 死信汇总 |
| GET | `/spot/ops/automation-executions` | `ops.assets.read` | 订单自动化执行记录 |
| POST | `/spot/ops/replay-engine` | `ops.ledger.execute` | 用持久化挂单重建撮合引擎订单簿 |
| POST | `/spot/ops/recovery-jobs/process` | `ops.ledger.execute` | 处理订单恢复任务 |
| POST | `/spot/ops/recovery-jobs/:jobId/recover` | `ops.ledger.execute` | 恢复单个任务 |
| POST | `/spot/ops/dead-letter-jobs/process` | `ops.ledger.execute` | 批量重排死信任务 |
| POST | `/spot/ops/dead-letter-jobs/:jobId/requeue` | `ops.ledger.execute` | 重排单个死信任务 |
| GET | `/spot/runtime-report` | `ops.assets.read` | 交易运行时报告 |
| GET | `/spot/runtime-drilldown` | `ops.assets.read` | 运行时明细 |
| GET | `/spot/runtime-alert-sinks` | `ops.alerts.read` | 告警投递目标 |
| GET | `/spot/runtime-alerts/export` | `ops.alerts.read` | 导出运行时告警 |
| POST | `/spot/runtime-alerts/deliver` | `ops.alerts.manage` | 投递运行时告警 |
| POST | `/spot/event-bus/replay` | `ops.ledger.execute` | 回放成交事件流 |
| POST | `/spot/event-bus/trim` | `ops.ledger.execute` | 裁剪事件流 |
| POST | `/spot/event-bus/maintenance` | `ops.ledger.execute` | 事件流维护 |
| POST | `/spot/event-bus/self-heal` | `ops.ledger.execute` | 事件总线自愈 |
| POST | `/spot/event-bus/process` | `ops.ledger.execute` | 执行一轮结算消费 |
| GET | `/indexer/overview` | `ops.indexer.read` | 索引器总览（游标、积压、reorg） |
| GET | `/indexer/pending-deposits` | `ops.indexer.read` | 待处理充值观测 |
| POST | `/indexer/replay` | `ops.indexer.execute` | 按区块范围重扫 |
| POST | `/indexer/backlog/repair` | `ops.indexer.execute` | 修复积压（`lookbackBlocks?`） |
| POST | `/indexer/pending-deposits/:observationId/replay` | `ops.indexer.pending.manage` | 重放单条观测 |
| POST | `/indexer/pending-deposits/:observationId/close` | `ops.indexer.pending.manage` | 关闭单条观测 |
| POST | `/indexer/pending-deposit-batches/replay` | `ops.indexer.pending.manage` | 批量重放（`observationIds[]`） |
| POST | `/indexer/pending-deposit-batches/close` | `ops.indexer.pending.manage` | 批量关闭（`observationIds[]`） |
| GET | `/custody/overview` | `ops.custody.read` | 托管总览 |
| GET | `/custody/providers/health` | `ops.custody.read` | 托管提供方健康 |
| POST | `/custody/providers/health/check` | `ops.providers.manage` | 立即执行健康检查 |
| GET | `/alerts` | `ops.alerts.read` | 告警汇总 |
| GET | `/audit-logs/withdrawals` | `ops.audit.read` | 提币审计日志搜索 |
| GET | `/audit-logs/actions` | `ops.audit.read` | 运营操作审计日志 |
| GET | `/execution-templates` | `ops.audit.read` | 运维执行模板 |
| POST | `/execution-templates/:templateId/execute` | `ops.ledger.execute` | 执行模板 |
| GET | `/execution-history` | `ops.audit.read` | 执行历史 |
| GET | `/execution-history/diff` | `ops.audit.read` | 两次执行的差异 |
| GET | `/execution-schedules` | `ops.audit.read` | 定时执行计划 |
| POST | `/execution-schedules/run` | `ops.ledger.execute` | 运行到期计划 |

### 5.4 故障实验室（`/api/v1/ops/lab`）

读取对所有运营角色开放（`ops.dashboard.read`）；任何注入或恢复动作需要同时具备 `ops.ledger.execute`、`ops.providers.manage`、`ops.indexer.execute`（即 `ops_admin`）。用法见 [fault-lab.md](fault-lab.md)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 实验室状态（`market?`） |
| POST | `/settlement/pause` | 暂停结算消费（`durationSeconds?`） |
| POST | `/settlement/resume` | 恢复结算消费 |
| POST | `/custody/inject` | 注入托管广播失败（`providerName?`、`durationSeconds?`） |
| POST | `/custody/probe` | 发起一次探测广播 |
| POST | `/custody/clear` | 清除托管故障 |
| POST | `/chain/halt` | 通过 demo-simulator 暂停本地链出块（`durationSeconds?`） |
| POST | `/chain/resume` | 恢复出块 |
| POST | `/chain/seed-deposit` | 制造一笔实验充值 |
| POST | `/chain/reorg` | 触发链重组（`depth?`） |
| POST | `/indexer/reorg-acknowledge` | 确认 reorg 告警 |
| POST | `/engine/reset` | 清空撮合引擎内存订单簿 |
| POST | `/recover-all` | 一键恢复所有注入的故障 |

### 5.5 角色与权限

| 角色 | 权限 |
| --- | --- |
| `ops_admin` | 全部权限 |
| `ops_reviewer` | dashboard、提币读 / 审核 / 批量审核、充值读、通知读、地址簿读、审计读、告警读 |
| `ops_finance_operator` | dashboard、提币读、资产读、账本读 / 执行 / 管理、充值读、通知读 / 管理、地址簿读、审计读、告警读 |
| `ops_risk_operator` | dashboard、提币读、用户读 / 冻结、充值读、地址簿读 / 管理、审计读、告警读、市场读 / 管理 |
| `ops_platform_operator` | dashboard、通知读 / 管理、索引器读 / 执行 / 管理 / 待处理管理、托管读、提供方管理、审计读、告警读、市场读 |
| `ops_observer` | 只读：dashboard、提币、用户、资产、账本、充值、通知、索引器、托管、地址簿、审计、告警、市场 |

没有分配角色的运营账号默认是 `ops_observer`。完整映射见 `services/identity-service/src/domain/rbac.ts`。

### 5.6 钱包与储备金（`/api/v1/ops/treasury`）

冷热分层、归集、热钱包水位调拨、钱包 vs 账本对账和储备金证明，全部转发给 wallet-service 的 `/api/v1/wallet/treasury/*`。所有写操作写 `ops_action_audit_logs`（动作 `treasury.*`），并把运营人（邮箱，缺省为 userId）作为 `requestedBy` / `reviewedBy` / `generatedBy` 传下去。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/overview` | `ops.ledger.read` | 每个币种的充值地址 / 热 / 冷 / 在途持仓、水位与水位状态、热冷钱包地址、未完成转账数、待审批数 |
| GET | `/transfers` | `ops.ledger.read` | 内部转账列表（`kind?`、`status?`、`statuses?` 逗号分隔、`assetCode?`、分页） |
| GET | `/transfers/:transferId` | `ops.ledger.read` | 详情，归集附带 `sweptDepositIds`，`events` 为状态历史 |
| POST | `/transfers` | `ops.ledger.execute` | 手动发起调拨提案（`kind`：`rebalance_to_cold` / `rebalance_to_hot`，`assetCode`、`amount`、`network?`、`reason?`） |
| POST | `/transfers/:transferId/approve` | `ops.withdrawals.review` | 批准并广播（`note?`）；提案人自己批准返回 `409 TREASURY_SAME_APPROVER`，来源钱包余额不足返回 `409 TREASURY_INSUFFICIENT_BALANCE` |
| POST | `/transfers/:transferId/reject` | `ops.withdrawals.review` | 拒绝提案（`reason?`） |
| POST | `/transfers/:transferId/retry` | `ops.ledger.execute` | 重新广播失败的调拨 |
| POST | `/sweeps/run` | `ops.ledger.execute` | 立即执行一轮归集 |
| POST | `/watermarks/evaluate` | `ops.ledger.execute` | 立即检查热钱包水位，越界时生成提案 |
| GET | `/reconciliation` | `ops.ledger.read` | 钱包 vs 账本对账（见 6.3 节） |
| POST | `/proof-of-reserves/snapshots` | `ops.ledger.execute` | 生成储备金证明快照 |
| GET | `/proof-of-reserves/snapshots` | `ops.ledger.read` | 快照列表（`limit?`，不含叶子） |
| GET | `/proof-of-reserves/snapshots/:snapshotId` | `ops.ledger.read` | 快照详情（不含叶子） |

---

## 6. 内部服务 API

以下接口只供服务之间、ops-console 和演示脚本调用。认证一列：“HMAC”指 1.2 节的内部服务签名，“无”表示服务本身不做认证，只能依赖网络隔离。

### 6.1 identity-service（`/api/v1/identity`，HMAC）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/users` | 创建用户（含运营账号与角色） |
| POST | `/auth/register` | 注册 customer |
| GET | `/users` | 用户搜索 |
| GET | `/users/:userId` | 用户详情 |
| POST | `/users/:userId/freeze` / `/unfreeze` | 冻结 / 解冻 |
| GET | `/users/:userId/two-factor` | 2FA 状态 |
| POST | `/users/:userId/two-factor/enroll` / `enable` / `verify` / `disable` / `recovery-codes` | 2FA 生命周期；`verify` 供 wallet 校验提币验证码 |
| GET | `/users/:userId/kyc` | KYC 档案 |
| POST | `/users/:userId/kyc/requests` | 提交 KYC 申请 |
| POST | `/users/:userId/kyc/tier` | 设置 KYC 等级 |
| GET | `/kyc/requests` | KYC 申请列表 |
| POST | `/kyc/requests/:requestId/approve` / `reject` | 审核 KYC |
| POST | `/auth/sessions` | 创建 customer 会话 |
| GET | `/auth/sessions/current` | 内省 customer 会话（Bearer） |
| POST | `/auth/sessions/logout` | 撤销 customer 会话（Bearer） |
| POST | `/ops/sessions` | 创建运营会话（校验 TOTP） |
| GET | `/ops/sessions/current` | 内省运营会话（Bearer） |
| POST | `/ops/sessions/logout` | 撤销运营会话（Bearer） |
| POST | `/users/:userId/api-keys` | 创建 API key |
| GET | `/users/:userId/api-keys` | 列出 API key |
| POST | `/users/:userId/api-keys/:apiKeyId/revoke` | 撤销 API key |
| POST | `/internal/api-keys/verify-signature` | gateway 提交 `keyId`、`canonicalRequest`、`signature`，identity 解密 secret 并比对 HMAC |

### 6.2 ledger-service（`/api/v1/ledger`，HMAC）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/accounts` | 创建账户（`accountId`、`userId?`、`accountType`、`status?`），已存在时返回原记录 |
| GET | `/accounts/:accountId` | 账户详情 |
| POST | `/journals` | 记一笔借贷平衡的 journal（按 `idempotencyKey` 幂等） |
| GET | `/journals` | journal 摘要（`businessType`、`businessId`、`idempotencyKey`、分页） |
| GET | `/journals/:journalId` | journal 及分录 |
| GET | `/balances` | 余额列表（`userId`、`accountId`、`assetCode`、`accountType`、`accountStatus`、分页） |
| GET | `/balances/:accountId/:assetCode` | 单个余额快照（不存在时返回零值） |
| POST | `/balances/freeze` | 冻结 |
| POST | `/balances/release` | 释放（可部分） |
| POST | `/balances/consume` | 消耗冻结并记入结算账户（需 `settlementAccountId`） |
| GET | `/accounts/:accountId/entries` | 账户分录（`assetCode`、`journalId`、`businessType`、`businessId`、`referenceType`、`referenceId`、分页） |
| GET | `/accounts/:accountId/statement` | 资金流水（参数同 2.2 节） |
| GET | `/ops/reconciliation` | 对账报告（`accountId?`、`assetCode?`、`includeMatched?`） |
| POST | `/ops/reconciliation/run` | 同上，参数放请求体 |
| GET | `/ops/replay` | 回放（`accountId`、`assetCode` 必填） |
| POST | `/ops/replay/run` | 同上，参数放请求体 |
| GET | `/ops/overview` | 运维总览（`staleLockMinutes?`） |
| POST | `/ops/outbox/drain` | 重排死信并发布（`requeueDeadLetter?`、`maxCycles?`） |
| GET | `/ops/liabilities` | 用户负债汇总（`assetCode?`）：只统计 `user_id` 非空账户的 `available + locked`，返回 `{ generatedAt, userCount, assets: [{ assetCode, available, locked, total, userCount }] }` |
| GET | `/ops/liabilities/users` | 每个用户各币种负债合计（`assetCode?`），`{ items: [{ userId, balances: { ETH: "5" } }] }`，供储备金证明建树 |

`/ops/*` 只在 Postgres 模式下可用。各操作语义见 [ledger-service-design.md](ledger-service-design.md)。

### 6.3 wallet-service（`/api/v1/wallet`，HMAC）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/deposit-addresses` | 分配充值地址 |
| GET | `/deposit-addresses` | 地址列表 |
| POST | `/deposits/confirm` | indexer 上报充值确认（`network`、`txHash`、`address`、`amount`、`confirmations`、`blockNumber?`），达到阈值后入账 |
| GET | `/deposits` | 充值列表 |
| GET | `/deposits/:depositId` | 充值详情 |
| POST | `/withdrawals/validate` | 提币预检（不冻结、不消耗验证码） |
| POST | `/withdrawals/request` | 发起提币并冻结 |
| GET | `/withdrawal-limits` | 用户提币额度（`userId`） |
| GET | `/withdrawals` | 提币列表 |
| GET | `/withdrawals/review-queue` | 审核队列 |
| GET | `/withdrawals/:withdrawalId` | 提币详情 |
| GET | `/withdrawals/:withdrawalId/audit-logs` | 单笔审计日志 |
| GET | `/audit-logs` | 审计日志搜索 |
| POST | `/withdrawals/:withdrawalId/approve` | 批准（`reviewedBy?`、`note?`） |
| POST | `/withdrawals/:withdrawalId/reject` | 拒绝并释放冻结（`reviewedBy?`、`reason?`） |
| POST | `/withdrawals/confirm` | indexer 上报提币确认（`network`、`txHash`、`confirmations`、`blockNumber?`），消耗冻结 |
| POST | `/withdrawal-address-book` | 新增地址簿条目 |
| GET | `/withdrawal-address-book` | 地址簿列表 |
| POST | `/withdrawal-address-book/:addressBookId/whitelist` / `unwhitelist` | 白名单开关 |
| GET | `/notifications` | 通知列表 |
| GET | `/notifications/unread-count` | 未读数（`userId`） |
| POST | `/notifications/read` | 标记已读（`userId`、`notificationIds?`，省略即全部） |
| POST | `/ops/notifications/deliver` | 投递通知 |
| POST | `/ops/withdrawals/reconcile-stale` | 处理停滞提币 |

treasury（冷热分层与储备金证明，`/api/v1/wallet/treasury`，错误码 `TREASURY_TRANSFER_NOT_FOUND` 404、`TREASURY_INVALID_STATE` / `TREASURY_SAME_APPROVER` / `TREASURY_INSUFFICIENT_BALANCE` 409、`TREASURY_INVALID_REQUEST` 400、`TREASURY_UPSTREAM_FAILED` 502、`POR_SNAPSHOT_NOT_FOUND` 404）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/treasury/overview` | 持仓分层、水位、热冷钱包地址 |
| GET | `/treasury/transfers` | 内部转账列表（`kind?`、`status?`、`statuses?`、`assetCode?`、`network?`、`txHash?`、分页） |
| GET | `/treasury/transfers/:transferId` | 详情（含 `sweptDepositIds`） |
| POST | `/treasury/transfers` | 调拨提案（`kind`、`assetCode`、`amount`、`requestedBy`、`network?`、`reason?`） |
| POST | `/treasury/transfers/:transferId/approve` | 批准并经 custody-adapter 广播（`reviewedBy`、`note?`） |
| POST | `/treasury/transfers/:transferId/reject` | 拒绝（`reviewedBy`、`reason?`） |
| POST | `/treasury/transfers/:transferId/retry` | 重新广播失败的调拨（`requestedBy`） |
| POST | `/treasury/transfers/confirm` | 链上确认回报（`network`、`txHash`、`confirmations`、`blockNumber?`），达到 `TREASURY_TRANSFER_CONFIRMATION_THRESHOLD` 后到账；演示中由 demo-simulator 调用 |
| POST | `/treasury/sweeps/run` | 归集：未归集的已入账充值按 (地址, 币种) 各发一笔到热钱包（`requestedBy?`） |
| POST | `/treasury/watermarks/evaluate` | 水位检查，越界生成 `proposed` 调拨（`requestedBy?`） |
| POST | `/treasury/genesis` | 记录平台资金上链（`assetCode`、`walletType`：`hot`/`cold`、`amount`、`reference`、`network?`、`note?`），按 `reference` 幂等；演示 bootstrap 与储备补足使用 |
| GET | `/treasury/reconciliation` | 钱包 vs 账本：`items[]` 每个币种 `depositAddresses`、`hot`、`cold`、`internalInTransit`、`reserves`、`ledgerLiabilities`、`withdrawalsInFlight`、`netLiabilities`、`surplus`、`reserveRatio`、`hotCoverage`、`status`（`covered` / `shortfall` / `no_liabilities`），顶层 `status`、`shortfallCount`、`holdings` |
| POST | `/treasury/proof-of-reserves/snapshots` | 生成快照（`generatedBy?`） |
| GET | `/treasury/proof-of-reserves/snapshots` | 快照列表（`limit?`） |
| GET | `/treasury/proof-of-reserves/snapshots/:snapshotId` | 快照详情 |
| GET | `/treasury/proof-of-reserves/me` | 某用户在最新快照中的叶子与路径（`userId`），网关 `/proof-of-reserves` 使用 |

### 6.4 order-service（HMAC）

订单与成交：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/orders` | 下单（`userId`、`accountId`、`market`、`side`、`type`、`timeInForce?`、`price?`、`quantity`、`idempotencyKey`、`traceId?`）：风控 → 冻结 → 撮合 → 结算 |
| POST | `/api/v1/orders/:orderId/cancel` | 撤单（`userId`） |
| GET | `/api/v1/orders` | 订单列表（`userId`、`accountId`、`market`、`status`、分页） |
| GET | `/api/v1/orders/:orderId` | 订单详情 |
| GET | `/api/v1/trades` | 成交列表（`userId`、`market`、`orderId`、分页） |
| GET | `/api/v1/trades/events` | 成交事件列表 |
| GET | `/api/v1/trades/:tradeId` | 成交详情 |
| POST | `/api/v1/trades/:tradeId/settlement` | settlement-service 回写结算结果 |

运维（`/api/v1/orders/ops`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/overview`、`/anomalies` | 总览与异常 |
| POST | `/replay-engine` | 用持久化挂单重建撮合订单簿 |
| POST | `/lab/engine-reset` | 故障实验：清空引擎订单簿 |
| GET | `/recovery-jobs`、`/recovery-metrics`、`/recovery-governance`、`/automation-executions` | 恢复任务与治理 |
| POST | `/recovery-jobs/process`、`/recovery-jobs/:jobId/recover` | 处理恢复任务 |
| GET | `/dead-letter-jobs`、`/dead-letter-report`、`/dead-letter-templates` | 死信任务 |
| POST | `/dead-letter-jobs/requeue`、`/dead-letter-jobs/:jobId/requeue` | 重排死信 |
| GET | `/event-bus`、`/event-bus/streams`、`/event-bus/streams/events` | 成交事件流报告 |
| POST | `/event-bus/streams/replay`、`/event-bus/streams/trim`、`/event-bus/streams/maintenance` | 事件流回放 / 裁剪 / 维护 |

### 6.5 risk-service（`/api/v1/risk`，HMAC）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/orders/validate` | 下单风控：市场状态、步长、最小数量、价格偏离；返回 `lockAssetCode`、`lockAmount`、`timeInForce` |
| GET | `/markets` | 市场及状态 |
| GET | `/markets/:market` | 单个市场 |
| POST | `/markets/:market/status` | 设置状态覆盖（`status`、`reason?`、`operator?`） |

### 6.6 settlement-service（`/api/v1/settlement`，HMAC）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/trades/settle` | 同步结算一笔成交 |
| GET | `/trades`、`/trades/report` | 结算记录与汇总 |
| POST | `/trades/:tradeId/recover` | 恢复单笔结算 |
| GET | `/recovery-jobs`、`/recovery-governance`、`/automation-executions` | 恢复任务与治理 |
| POST | `/recovery-jobs/process` | 处理恢复任务 |
| GET | `/event-bus`、`/event-bus/checkpoints` | 消费进度 |
| POST | `/events/trade-executed`、`/events/trade-executed/replay` | 消费 / 回放成交事件 |
| POST | `/event-bus/process` | 执行一轮订阅消费 |
| GET | `/lab/consumer` | 故障实验：消费者状态 |
| POST | `/lab/consumer/pause`、`/lab/consumer/resume` | 暂停 / 恢复消费者 |

### 6.7 custody-adapter（`/api/v1/custody`，无）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/transfers` | 创建托管转账：广播提币（幂等键 `withdrawal:<id>`），以及 wallet-service treasury 的归集 / 冷热调拨（幂等键 `treasury:<transferId>[:<attempt>]`，`metadata.purpose` 为 `treasury_sweep` 等） |
| GET | `/transfers/:custodyTransferId` | 转账详情 |
| POST | `/transfers/:custodyTransferId/retry` | 重试 |
| POST | `/transfers/:custodyTransferId/sync-status` | 同步链上状态 |
| GET | `/providers/health` | 提供方健康 |
| POST | `/providers/health/check` | 立即检查 |
| GET | `/ops/overview`、`/ops/report` | 运维总览与报告 |
| GET | `/lab/state` | 故障实验状态（`network?`） |
| POST | `/lab/failure-injection`、`/lab/failure-injection/clear`、`/lab/probe-broadcast` | 注入 / 清除故障、探测广播 |

### 6.8 blockchain-indexer（`/api/v1/indexer`，无）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/deposits/observe` | 手工上报充值观测 |
| POST | `/evm/deposits/scan` | 扫描 EVM 充值 |
| GET | `/deposits/:observationId` | 充值观测详情 |
| POST | `/withdrawals/observe` | 手工上报提币观测 |
| POST | `/evm/withdrawals/scan` | 扫描 EVM 提币 |
| GET | `/withdrawals/:observationId` | 提币观测详情 |
| GET | `/cursors/:observationType/:network` | 扫描游标 |
| GET | `/ops/overview` | 运维总览 |
| GET | `/ops/pending-deposits` | 待处理充值观测 |
| POST | `/ops/pending-deposits/:observationId/replay` / `close` | 重放 / 关闭观测 |
| POST | `/ops/replay` | 按区块范围重扫 |
| POST | `/ops/reorg/acknowledge` | 确认 reorg（`network?`） |
| POST | `/ops/backlog/repair` | 修复积压 |

### 6.9 matching-engine（TCP 3011，无）

每个 TCP 连接发送一行 JSON 命令、读取一行 JSON 响应后关闭。命令用 `action` 区分，字段为 snake_case：

| `action` | 字段 | 说明 |
| --- | --- | --- |
| `submit` | `order_id`、`market`、`side`、`order_type`、`time_in_force`、`price?`、`quantity`、`created_at` | 提交订单并撮合，返回成交列表或挂单结果 |
| `seed` | `order_id`、`market`、`side`、`price`、`quantity`、`created_at` | 不撮合直接挂单（重建订单簿用） |
| `cancel` | `order_id`、`market` | 撤单 |
| `reset` | `market`、`reset_sequences?` | 清空订单簿；`reset_sequences` 只在全量重置时使用 |
| `restore` | `market`、`next_execution_sequence`、`next_batch_sequence` | 重启后抬高序号，避免复用已持久化的成交 ID |
| `snapshot` | `market`、`limit?`（默认 50） | 订单簿快照 |

错误以 `{ "error": { "code": "...", "message": "..." } }` 形式返回，例如 `INVALID_COMMAND`、`PRICE_REQUIRED`。引擎状态只在内存中，重启后由 order-service 通过 `seed` + `restore` 重建，见 [architecture.md](architecture.md)。
