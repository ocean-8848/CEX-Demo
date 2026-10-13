# Identity Service

职责:

- 管理用户基础档案
- 管理 TOTP 2FA 绑定、启用和校验
- 管理用户端注册、登录、session 和 API Key
- 管理 ops 用户密码登录、会话和 RBAC
- 管理用户冻结 / 解冻
- 管理登录安全：登录记录、设备列表、新设备识别与提醒、按设备吊销会话、登录失败临时锁定
- 为 `api-gateway`、`wallet-service` 和 `ops-console` 提供身份底座

主链定位:

- 职责是把用户注册、登录、session、API Key、ops 登录和 2FA 放到统一身份层
- 学习时优先看 customer session、ops session、2FA 和 API Key
- 如果目标是解释“谁能进系统、谁能审批、程序化交易如何接入”，这里就是身份入口

当前实现:

- `createUser`
- `listUsers`
- `getUser`
- `enrollTwoFactor`
- `enableTwoFactor`
- `verifyTwoFactor`
- `getTwoFactorStatus`
- `createOpsSession`
- `introspectOpsSession`
- `revokeOpsSession`
- `registerCustomer`
- `createCustomerSession`
- `introspectCustomerSession`
- `revokeCustomerSession`
- `createApiKey`
- `listApiKeys`
- `revokeApiKey`
- `freezeUser`
- `unfreezeUser`
- `disableTwoFactor`（需要当前动态码或恢复码）
- `regenerateRecoveryCodes`（需要当前动态码）
- 一次性 2FA 恢复码：开启 2FA 时生成 8 个，只存 SHA-256 哈希（表 `identity_two_factor_recovery_codes`），登录 / 关闭 2FA 时可代替动态码，用后作废
- `two_factor_changed_at`：记录最近一次开启 / 关闭 2FA，供 wallet-service 计算提现冷却期
- KYC 等级（演示数据）：`getKycProfile / submitKycRequest / listKycRequests / approveKycRequest / rejectKycRequest / setKycTier`，
  等级 `unverified / L1 / L2` 存在 `identity_users.kyc_tier`，申请与每次等级变化分别记录在 `identity_kyc_requests` 与 `identity_kyc_events`；证件号只保存后 4 位
- 登录安全（`src/application/login-security-service.ts`、纯规则 `src/domain/login-security.ts`）：
  - 每次密码登录（客户与运营）写一条 `identity_login_events`（时间、IP、User-Agent、设备 ID、`success / failure / locked`、失败原因码）；未注册邮箱也记录
  - 设备 ID 来自登录请求体 `deviceId`（trader-web 存在 localStorage 的长期随机值），缺省时按 User-Agent 派生 `ua-<hash>`；设备登记在 `identity_user_devices`，会话的 `device_id` 记录创建它的设备
  - 新设备：账户已有其他设备、本次设备从未出现过 → 登录响应 `device.isNewDevice = true`，设备标记 `flagged_new`，并通过内部 HMAC 调用 wallet-service `POST /api/v1/wallet/notifications/security` 写「新设备登录」站内信（只对客户登录，失败不影响登录）
  - `revokeDevice`：吊销该设备上所有未过期、未吊销的会话
  - 登录失败锁定：自上次成功登录起、窗口内密码 / 动态码 / 恢复码错误次数达到阈值后锁定（`429 LOGIN_TEMPORARILY_LOCKED`，消息带 `remainingSeconds`）；缺少动态码、动态码重复使用不计入；锁定检查在密码校验之前
  - `GET /users/:userId/login-security` 返回 `lastNewDeviceLoginAt`，供 wallet-service 的可选新设备提现锁使用
- PostgreSQL 持久化、表结构初始化脚本、HTTP API
- 被 `wallet-service` 提币 2FA 校验链路调用
- 支撑 `ops-console` ops 登录和 RBAC（角色 → 权限映射在 `src/domain/rbac.ts`；紧急开关权限 `ops.controls.manage` 只授予 `ops_admin`）

SQL schema:

- [001_init.sql](sql/001_init.sql)
- [002_add_ops_auth_and_rbac.sql](sql/002_add_ops_auth_and_rbac.sql)
- [003_add_customer_auth_and_api_keys.sql](sql/003_add_customer_auth_and_api_keys.sql)
- [004_api_key_id_scopes.sql](sql/004_api_key_id_scopes.sql)
- [005_add_two_factor_recovery_and_kyc.sql](sql/005_add_two_factor_recovery_and_kyc.sql)（恢复码与 2FA 变更时间、KYC 等级 / 申请 / 事件）
- [006_add_login_events_and_devices.sql](sql/006_add_login_events_and_devices.sql)（登录事件、用户设备、会话 `device_id`）

运行脚本:

- `pnpm --filter @web3-cex/identity-service db:prepare`
- `pnpm --filter @web3-cex/identity-service start`
- `pnpm --filter @web3-cex/identity-service test`
- `pnpm --filter @web3-cex/identity-service typecheck`

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `PORT`（默认 `3005`）
- `DATABASE_URL`
- `IDENTITY_REPOSITORY`
- `TWO_FACTOR_ISSUER` / `TWO_FACTOR_TIME_STEP_SECONDS` / `TWO_FACTOR_DIGITS` / `TWO_FACTOR_WINDOW`
- `OPS_SESSION_TTL_HOURS`
- `CUSTOMER_SESSION_TTL_HOURS`
- `OPS_REQUIRE_TWO_FACTOR`
- `IDENTITY_API_KEY_ENCRYPTION_KEY`（API Key secret 加密主密钥，未写入示例文件，demo 有默认值）
- `IDENTITY_LOGIN_MAX_FAILURES`（默认 `5`，`0` 关闭锁定）/ `IDENTITY_LOGIN_FAILURE_WINDOW_SECONDS`（默认 `900`）/ `IDENTITY_LOGIN_LOCK_SECONDS`（默认 `300`）
- `IDENTITY_NEW_DEVICE_NOTIFY`（默认 `true`）/ `IDENTITY_WALLET_SERVICE_BASE_URL`（默认 `http://127.0.0.1:3002`）
- `INTERNAL_SERVICE_AUTH_SECRET` / `INTERNAL_SERVICE_CALLER_NAME`（调用 wallet-service 写站内信时签名，`pnpm stack:start` 自动注入）

HTTP 接口:

- `POST /api/v1/identity/users`
- `POST /api/v1/identity/auth/register`
- `GET /api/v1/identity/users`
- `GET /api/v1/identity/users/:userId`
- `POST /api/v1/identity/users/:userId/freeze`
- `POST /api/v1/identity/users/:userId/unfreeze`
- `POST /api/v1/identity/users/:userId/api-keys`
- `GET /api/v1/identity/users/:userId/api-keys`
- `POST /api/v1/identity/users/:userId/api-keys/:apiKeyId/revoke`
- `POST /api/v1/identity/internal/api-keys/verify-signature`（gateway 专用：`{ keyId, canonicalRequest, signature }`）

- `GET /api/v1/identity/users/:userId/two-factor`
- `POST /api/v1/identity/users/:userId/two-factor/enroll`
- `POST /api/v1/identity/users/:userId/two-factor/enable`
- `POST /api/v1/identity/users/:userId/two-factor/verify`
- `POST /api/v1/identity/users/:userId/two-factor/disable`（`{ code }`，动态码或恢复码）
- `POST /api/v1/identity/users/:userId/two-factor/recovery-codes`（`{ code }`，返回新的 `recoveryCodes`，只显示一次）
- `GET /api/v1/identity/users/:userId/kyc`
- `POST /api/v1/identity/users/:userId/kyc/requests`（`{ requestedTier, fullName, idNumber }`，演示字段）
- `POST /api/v1/identity/users/:userId/kyc/tier`（`{ tier, actorId, reason }`，运营手动调整）
- `GET /api/v1/identity/kyc/requests?status=pending`
- `POST /api/v1/identity/kyc/requests/:requestId/approve`（`{ reviewedBy, tier?, note? }`）
- `POST /api/v1/identity/kyc/requests/:requestId/reject`（`{ reviewedBy, note }`）
- `POST /api/v1/identity/auth/sessions`（`{ email, password, twoFactorCode?, deviceId? }`，响应带 `device: { deviceId, deviceLabel, isNewDevice }`）
- `GET /api/v1/identity/auth/sessions/current`
- `POST /api/v1/identity/auth/sessions/logout`
- `POST /api/v1/identity/ops/sessions`
- `GET /api/v1/identity/ops/sessions/current`
- `POST /api/v1/identity/ops/sessions/logout`
- `GET /api/v1/identity/users/:userId/login-events?outcome=&limit=&offset=`
- `GET /api/v1/identity/users/:userId/devices`（含每台设备的 `activeSessionCount`）
- `POST /api/v1/identity/users/:userId/devices/:deviceId/revoke`
- `GET /api/v1/identity/users/:userId/login-security`

API Key:

- 由公开 `keyId`（`ak_…`）和只显示一次的 `secret`（`sk_…`）组成，可选 scope `read / trade / withdraw`
- secret 用 AES-256-GCM 加密保存（主密钥 `IDENTITY_API_KEY_ENCRYPTION_KEY`），因为 HMAC 校验需要原文；签名只在 identity 内部重算，secret 不会经过 gateway

说明:

- ops 登录默认强制要求 2FA，除非显式把 `OPS_REQUIRE_TWO_FACTOR=false`
- 用户端如果已启用 2FA，登录时同样要求提交 `twoFactorCode`（6 位动态码或 `xxxx-xxxx` 恢复码）
- `enable` 的响应额外带 `recoveryCodes`（只返回这一次）；`GET two-factor` 返回 `recoveryCodesRemaining` 与 `changedAt`
- ops session 返回的是权限快照，角色修改后旧 session 不会自动提权
- 运营权限点 `ops.risk.read`（`ops_admin`、`ops_risk_operator`、`ops_reviewer`、`ops_observer`）与 `ops.risk.manage`（`ops_admin`、`ops_risk_operator`）用于提现地址黑名单

延伸阅读:

- [03 账户、身份与安全](../../learning/03-account-identity-security.md)
- [B03 账户安全风控](../../learning/backstage/B03-account-security.md)、[B01 合规](../../learning/backstage/B01-compliance.md)
- [安全设计](../../docs/security.md)
