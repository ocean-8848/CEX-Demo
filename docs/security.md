# 安全设计与威胁模型

本文说明这个学习型 CEX demo 在安全上做了什么、没做什么，以及如果要走向真实环境还差哪些东西。所有描述都以当前代码为准；文中的文件路径相对仓库根目录。

相关阅读：

- 系统全貌：[architecture.md](architecture.md)
- 接口与鉴权头格式：[api-contracts.md](api-contracts.md)
- 账本不变量：[ledger-service-design.md](ledger-service-design.md)
- 故障演练：[fault-lab.md](fault-lab.md)
- 课程背景：[账户与身份安全](../learning/03-account-identity-security.md)、[钱包与托管](../learning/04-wallet-custody.md)、[风控](../learning/09-risk-control.md)、[可靠性与安全事件](../learning/13-reliability-security-incidents.md)、[平台安全](../learning/backstage/B02-platform-security.md)、[账户安全](../learning/backstage/B03-account-security.md)、[安全工程](../learning/backstage/B11-security-engineering.md)

## 1. 安全边界与定位

### 1.1 这个 demo 想演示的安全能力

项目的目标是让学习者在一个可运行的系统里看到真实交易所常见的安全控制“长什么样、放在哪一层”：

- 用户与运营人员的登录、会话、2FA、RBAC
- 程序化交易的 API Key 签名、scope、防重放
- 网关的限流、幂等、账户归属校验
- 服务间请求的 HMAC 签名
- 提现链路上的限额、KYC 分级、地址簿 / 白名单、冷却期、双人审批、审计日志
- 账本的借贷平衡、冻结 / 释放、幂等记账

### 1.2 明确不在保护范围内的东西

以下是有意为之的简化，阅读代码时不要把它们当作漏洞去“修”，而要当作“真实环境必须替换的部分”来理解：

| 项目 | 当前状态 |
| --- | --- |
| 链与资产 | 默认使用 `scripts/demo-simulator.mjs` 中的模拟 EVM 链（按固定间隔出块、推进确认数），所有资产都是测试数据；`custody-adapter` 默认路由到 `mock-custody` / `mock-custody-backup` |
| 演示账号 | `scripts/mvp-demo-lib.mjs` 内置固定的交易员、做市商、运营账号、密码和 TOTP 种子；`pnpm -s ops:totp` 可直接打印运营账号的当前动态码 |
| 配置中的密钥 | `INTERNAL_SERVICE_AUTH_SECRET` 默认值 `web3-cex-local-internal-auth`（`scripts/internal-service-auth.mjs`）、API Key 加密主密钥默认值（`identity-service` 中 `IDENTITY_API_KEY_ENCRYPTION_KEY` 未设置时的兜底）、各 `.env.example` 中的 `PGPASSWORD=web3` 都是公开的测试值 |
| 基础设施 | `infra/local/docker-compose.yml` 使用默认账号密码（Postgres `web3/web3`），端口直接映射到宿主机，无 TLS |
| 部署形态 | 单机、单进程、本地回环地址；不考虑多机房、高可用、WAF、CDN |
| 真实身份核验 | KYC 只是一个分级状态机，证件号只做格式校验并脱敏存储，不接任何第三方核验 |

一句话：这是一个跑在本机、用模拟链和测试资产的学习项目，不用于真实资金。

## 2. 已实现的安全控制

### 2.1 网络暴露面

| 组件 | 监听方式 | 说明 |
| --- | --- | --- |
| `identity / wallet / ledger / order / settlement / risk` | `INTERNAL_SERVICE_BIND_HOST`，默认 `127.0.0.1` | 见各服务 `src/main.ts` |
| `matching-engine` | `MATCHING_ENGINE_HOST`，默认 `127.0.0.1` | 见 `engines/matching-engine/src/main.rs` |
| `trader-web`、`demo-simulator` | 显式绑定 `127.0.0.1` | 见 `apps/trader-web/src/main.ts`、`scripts/demo-simulator.mjs` |
| `api-gateway`、`market-data-service`、`ops-console`、`blockchain-indexer`、`custody-adapter` | `app.listen(port)`，未传 host | 启动日志打印的是 `127.0.0.1`，但未指定 host 时 Node 会监听所有网卡；在共享网络里需自行加防火墙或改为显式绑定 |

### 2.2 用户与运营身份（identity-service）

代码位置：`services/identity-service/src/domain/`、`services/identity-service/src/application/identity-application-service.ts`。详见 [identity-service README](../services/identity-service/README.md)。

- **密码**：PBKDF2-SHA512，210000 次迭代，16 字节随机盐，常量时间比较（`domain/password.ts`）。
- **会话**：随机 token，库里只存 SHA-256 哈希；客户会话默认 168 小时（`CUSTOMER_SESSION_TTL_HOURS`），运营会话默认 12 小时（`OPS_SESSION_TTL_HOURS`）；支持主动吊销。会话自省时会拒绝已吊销、已过期以及用户状态非 `active`（如被冻结）的会话。
- **TOTP 2FA**（`domain/totp.ts`）：6 位、30 秒步长、允许 ±1 个步长误差；记录 `lastVerifiedCounter`，同一个或更早的动态码不能二次使用。
- **恢复码**（`domain/recovery-codes.ts`）：开启 2FA 时生成 8 个一次性恢复码，只展示一次，库里存加用户 ID 的 SHA-256 哈希，使用后标记 `used_at`。
- **运营强制 2FA**：`OPS_REQUIRE_TWO_FACTOR` 默认开启，未绑定 2FA 的运营账号无法登录 `ops-console`。
- **客户自助 2FA**：开启、关闭、重新生成恢复码的接口只接受会话鉴权，API Key 无法关闭 2FA（`services/api-gateway/src/http/api-gateway.controller.ts`）。
- **RBAC**（`domain/rbac.ts`）：6 个运营角色 `ops_admin / ops_reviewer / ops_finance_operator / ops_risk_operator / ops_platform_operator / ops_observer`，映射到细粒度权限（如 `ops.withdrawals.review`、`ops.ledger.execute`、`ops.users.freeze`）。未指定角色时默认 `ops_observer`（只读）。
- **KYC 分级**（`domain/kyc.ts`）：`unverified → L1 → L2`，只能逐级申请、由运营审核；证件号脱敏后存储。

### 2.3 客户入口（api-gateway）

代码位置：`services/api-gateway/src/http/`。详见 [api-gateway README](../services/api-gateway/README.md)。

- **两种认证方式**（`api-gateway-auth.guard.ts`）：`Authorization: Bearer <session>`，或 API Key 四个头 `X-API-Key / X-API-Timestamp / X-API-Nonce / X-API-Signature`。只接受客户类主体，运营会话和运营 API Key 会被拒绝。
- **API Key 设计**（`services/identity-service/src/domain/api-key-secret.ts`、`api-key-signature.ts`）：
  - 公开的 `keyId` + 只在创建时展示一次的 `secret`；secret 用 AES-256-GCM 加密后存库，网关从不接触 secret，由 identity 重算 HMAC。
  - 签名串为 `METHOD \n path+query \n timestamp \n nonce \n SHA256(body)`，HMAC-SHA256，常量时间比较。
  - 时间戳漂移窗口默认 5 分钟（`GATEWAY_API_KEY_MAX_DRIFT_MS`）。
  - nonce 必须是 8–64 位 `[A-Za-z0-9_-]`；签名验证通过后才写入 nonce 存储（Redis，TTL 为漂移窗口的 2 倍），重复 nonce 返回 `API_KEY_NONCE_REPLAYED`。
  - scope 分为 `read / trade / withdraw`，默认只给 `read + trade`，`withdraw` 需显式申请。路由上用 `@RequireApiKeyScope` 标注；未标注时 `GET` 需要 `read`，其他方法需要 `trade`。
- **账户归属**：涉及 `accountId / ledgerAccountId` 的请求都会校验账户属于当前主体，否则返回 403（`application/api-gateway-application-service.ts`）。
- **限流**（`api-gateway-rate-limit.guard.ts`）：固定窗口，默认 60 秒内匿名 30 次（按 IP）、已认证 120 次（按主体），存储默认 Redis；响应带 `x-rate-limit-*` 头。
- **幂等**（`api-gateway-idempotency.interceptor.ts`）：标注 `@GatewayIdempotentRoute` 的写接口（下单、提现申请、创建 API Key、新增地址簿等）按 `Idempotency-Key` 缓存结果，默认 1 小时；下单接口强制要求幂等键。
- **请求审计**：`api-gateway-audit.interceptor.ts` 对每个请求记录主体、路径、状态码、耗时与限流信息。
- **私有 WebSocket**（`api-gateway-realtime-server.ts`、`realtime-connection-guards.ts`）：
  - 握手阶段校验 `Origin`（`GATEWAY_WS_ALLOWED_ORIGINS`，默认只允许 `trader-web` 的地址）；没有 `Origin` 的非浏览器客户端放行。
  - 每连接消息限流，超过 2 倍阈值直接断开。
  - 会话到期主动断开，并定期重新自省 token，登出或冻结后连接随之关闭。
  - 支持首帧消息认证；为兼容脚本客户端，仍接受 URL query 中的 `token / apiKey`。

### 2.4 浏览器会话（trader-web / ops-console）

代码位置：`apps/trader-web/src/session.ts`、`apps/trader-web/src/server.ts`、`apps/ops-console/src/http/ops-session-cookie.ts`、`apps/ops-console/src/http/ops-auth.guard.ts`。

- 两个前端都由自身的 Web Host / BFF 持有会话 token，写入 `HttpOnly; SameSite=Strict; Path=/` Cookie，页面脚本读不到 token。`Secure` 标记由 `TRADER_WEB_COOKIE_SECURE` / `OPS_COOKIE_SECURE` 控制，本地 HTTP 默认关闭。
- 写操作采用 double-submit CSRF：可读的 `tw_csrf` / `ops_csrf` Cookie 必须原样放进 `x-csrf-token` 头，常量时间比较。显式带 `Bearer` 的脚本调用不走 Cookie，因此豁免 CSRF。
- `trader-web` 在代理私有 WebSocket 时把 Cookie 中的 token 转成 `Authorization` 头，token 不出现在浏览器 URL 中。
- `ops-console` 的每个接口用 `@RequireOpsPermissions` 声明所需权限，`OpsAuthGuard` 自省会话后逐项比对。
- 两个前端都没有设置 CSP、`X-Frame-Options` 等安全响应头。

### 2.5 服务间认证

代码位置：`packages/domain/src/index.ts`（签名算法）、各服务 `src/http/internal-service-auth.guard.ts`（校验）、各服务 `src/infrastructure/internal-service-request.ts`（签名）、`scripts/internal-service-auth.mjs`（脚本侧实现）。

- `identity / wallet / ledger / order / settlement / risk` 6 个服务通过 `APP_GUARD` 全局启用 `InternalServiceAuthGuard`。
- 调用方带 `x-internal-service-name / x-internal-service-timestamp / x-internal-service-signature` 三个头；签名串为 `callerName \n METHOD \n path \n timestamp \n SHA256(rawBody)`，HMAC-SHA256。
- 校验项：调用方在允许列表内（`INTERNAL_SERVICE_ALLOWED_CALLERS` 可覆盖默认列表）、时间戳偏差不超过 30 秒、签名常量时间比较。
- 未配置 `INTERNAL_SERVICE_AUTH_SECRET` 时守卫直接返回 503，即“未配置即拒绝”。
- 所有服务共用同一个密钥；`blockchain-indexer`、`custody-adapter`、`market-data-service` 作为调用方会签名，但自身入口不校验。`demo-simulator` 的 `/internal/lab/*` 故障演练接口同样要求签名。
- `order-service → matching-engine` 是单行 JSON over TCP，无认证，只依赖回环监听。

### 2.6 交易与账本

- **下单前风控**（`services/risk-service/src/application/risk-application-service.ts`）：市场状态（暂停 / 下架时拒绝新单、撤单始终放行）、价格与数量步长、可用余额校验。详见 [risk-service README](../services/risk-service/README.md)。
- **账本不变量**（`services/ledger-service/src/application/ledger-application-service.ts`）：每笔 journal 按资产借贷平衡，否则拒绝；`idempotencyKey` 去重；冻结 / 释放 / 消耗都检查可用余额与锁状态。运营端没有“直接改余额”的接口，余额调整也必须走 journal。详见 [ledger-service-design.md](ledger-service-design.md)。

### 2.7 提现控制（wallet-service）

代码位置：`services/wallet-service/src/application/wallet-application-service.ts`、`src/domain/withdrawal-policy.ts`、`src/infrastructure/withdrawal-validation-rules.ts`。详见 [wallet-service README](../services/wallet-service/README.md)。

提现申请的校验顺序大致为：资产 / 网络在 `config/markets.json` 中存在 → 安全冷却期 → 最小金额与手续费 → 白名单 → 单笔 / 日累计限额（含 KYC 分级）→ 2FA。动态码放在最后验证，避免被其他规则拒绝时白白消耗一次性动态码。

| 控制 | 规则 | 默认值 / 开关 |
| --- | --- | --- |
| 2FA | 用户已开启 2FA 时，提现必须带有效动态码（或恢复码）；`WITHDRAWAL_REQUIRE_2FA=true` 时未开启 2FA 的用户不能提现 | 全局强制默认关闭 |
| 地址簿 / 白名单 | 用户可维护提现地址簿，运营可标记 / 取消白名单；`WITHDRAWAL_REQUIRE_WHITELIST=true` 时只能提到已加白地址 | 默认关闭 |
| 单笔 / 日限额 | `WITHDRAWAL_SINGLE_LIMIT_BY_ASSET`、`WITHDRAWAL_DAILY_LIMIT_BY_ASSET`，日窗口按 UTC 自然日 | 未配置则不限 |
| KYC 分级限额 | 按 `unverified / L1 / L2` 取单笔与日限额，与全局限额取较小值 | 默认开启，默认表见 `DEFAULT_KYC_TIER_LIMITS` |
| 安全冷却期 | 新增提现地址或修改 2FA 后，在 `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS` 内禁止提现 | 代码默认 86400 秒；`pnpm demo:up` 启动的演示栈传入 0 |
| 双人审批 | 金额严格大于分资产阈值时需要两名不同运营批准；同一运营不能批两次；审批策略在申请时固化到记录里 | `USDT=5000, USDC=5000, ETH=2, BTC=0.1, SOL=50` |
| 人工审核 | 所有提现申请都以 `requested / pending` 进入审核队列，审批人身份取自 `ops-console` 会话的 `userId` | 始终开启 |

### 2.8 审计与可追溯

- `withdrawal_audit_logs`（`services/wallet-service/sql/006_add_withdrawal_audit_and_notifications.sql`）：记录提现 `requested / approved / rejected / broadcasted / confirmed`，含操作人、角色、`trace_id`、前后快照。
- `ops_action_audit_logs`（`apps/ops-console/sql/001_init.sql`）：记录每个运营动作的操作人、角色、所用权限、目标、请求 / 响应、成功或失败；`ops-console` 中可按操作人、动作、目标检索。
- identity 的 `identity_kyc_events` 记录 KYC 申请与审核过程。
- 服务链路接入 OpenTelemetry，可在 Jaeger 里按 trace 串起一次请求经过的服务。

### 2.9 托管与链上

- `custody-adapter` 有两类 provider：默认的 `mock-custody` / `mock-custody-backup`（带熔断与故障切换，见 [fault-lab.md](fault-lab.md)），以及 `evm-hot-wallet`（`src/infrastructure/evm-custody-provider.ts`），后者从环境变量 `CUSTODY_EVM_PRIVATE_KEY_*` 或 `CUSTODY_EVM_MNEMONIC` 读取密钥直接本地签名广播。
- 广播请求带幂等键，失败有重试上限（`CUSTODY_MAX_BROADCAST_ATTEMPTS`）。
- 充值与提现按确认数阈值推进（`DEPOSIT_CONFIRMATION_THRESHOLD`、`WITHDRAWAL_CONFIRMATION_THRESHOLD`、`INDEXER_CONFIRMATION_THRESHOLD`，默认 12）；模拟链支持停止出块和重组演练。

### 2.10 冷热分层与储备金证明（wallet-service treasury）

- 平台链上持仓按 **充值地址 → 热钱包 ⇄ 冷钱包** 分层记录（`treasury_transfers`），与账本分开记账：账本记"欠用户多少"，treasury 记"币在哪里"。两本账独立，`/treasury/reconciliation` 才能逐币种发现储备不足。
- 提现一律从热钱包付出；热钱包设水位上下限（`TREASURY_HOT_WALLET_WATERMARKS`），高于上限自动提出 热→冷 调拨，低于下限提出 冷→热 补充。调拨提案必须经运营审批：审批人需有 `ops.withdrawals.review`，且不能是提案人（`TREASURY_SAME_APPROVER`），批准前校验来源钱包余额，所有动作写 `ops_action_audit_logs` 并在转账记录的 `events` 中留痕。
- 归集（充值地址 → 热钱包）不需要审批：目标是平台自己的热钱包地址，由服务端固定，不能由请求指定。
- 储备金证明：叶子 = 盐化用户哈希 + 各币种余额，盐值是每期快照、每个用户随机生成的 nonce；网关只按当前登录用户返回他自己的叶子和兄弟哈希路径，响应里不含其他用户 ID 或余额。

**与真实环境的差距**（演示简化）：

- 热钱包、冷钱包都只是派生出来的演示地址，冷钱包"签名"同样经 `custody-adapter`（转账元数据标注 `cold-wallet (simulated offline signing)`），没有离线签名、多签 / MPC、硬件隔离。
- 冷→热补充只要一人审批，没有分级审批、时间窗、单笔上限和白名单变更审批（见 [B06](../learning/backstage/B06-treasury-liquidity.md) 第 5.2 节）。
- 演示环境的储备由"注资上链"（genesis）记录补足：模拟器把期初权益发给用户的余额对应为平台自有资金上链（`DEMO_RESERVE_KEEPER_ENABLED`）。真实交易所的储备必须来自链上可查的地址余额，并由第三方审计。
- 储备金证明只有 Merkle 包含证明，没有 zk-SNARK 证明"无负余额叶子、叶子总和等于负债"；资产端没有链上地址签名证明（proof of control）。

详见 [custody-adapter README](../services/custody-adapter/README.md)、[blockchain-indexer README](../services/blockchain-indexer/README.md)、[wallet-service README](../services/wallet-service/README.md)。

## 3. 威胁模型

假设前提：攻击者能访问对外入口（`trader-web`、`ops-console`、`api-gateway`、`market-data-service`），可能持有自己的客户账号或窃取到他人凭证；不假设攻击者已拿到宿主机 root。

| 资产 | 威胁 | demo 中的现有缓解 | 真实 CEX 还会加什么 |
| --- | --- | --- | --- |
| 客户会话 | XSS / 恶意扩展窃取 token；CSRF 冒用会话 | HttpOnly + SameSite=Strict Cookie；double-submit CSRF；token 哈希存储、可吊销、冻结即失效 | CSP 与输入转义、设备绑定、新设备登录提醒、会话轮换、敏感操作 step-up |
| 登录凭证 | 撞库、暴力破解 | PBKDF2 高迭代哈希；网关按 IP 限流；可选 2FA | 登录失败锁定、验证码、风险评分、泄露密码库比对；限流 IP 不直接信任 `X-Forwarded-For`（当前取其第一个值） |
| API Key | 泄露、重放、越权使用 | keyId + 加密 secret；nonce 防重放；5 分钟漂移窗口；`read/trade/withdraw` scope | IP 白名单、key 有效期、提现权限单独审批、异常调用告警 |
| 2FA 种子 | 数据库泄露后可伪造动态码 | 动态码单次使用；恢复码哈希存储 | TOTP 种子加密存储或放入独立密钥服务；支持 WebAuthn / 硬件密钥 |
| 运营会话与审批权 | 运营 token 被盗或内部人员作恶，批准恶意提现 | 运营强制 2FA；12 小时 TTL；RBAC 细粒度权限；大额双人审批；全量动作审计 | 审批时 step-up、硬件密钥、审批 IP / 设备绑定、批量审批分权、审计日志防篡改 |
| 提现链路 | 账号被盗后快速提走资产 | 已开 2FA 必须带动态码；KYC 分级限额；安全冷却期；可选白名单 | 默认强制白名单与冷却期、地址风险筛查（制裁 / 混币）、行为风控、紧急全局暂停 |
| 热钱包私钥 | 环境变量泄露、误把真实私钥 / RPC 配进来 | 默认走 mock provider；模拟链；无真实资产；冷热分层 + 热钱包水位上限，超限自动提出 热→冷 调拨 | HSM / MPC / KMS 签名，冷钱包离线 / 多签，链上监控 |
| 平台储备 | 挪用用户资产、储备不足仍继续营业 | 钱包 vs 账本逐币种覆盖率对账；调拨需第二人审批并审计；储备金证明让用户自证余额被计入 | 第三方审计、zk 负债证明、链上地址控制权证明、储备不足自动停提现 |
| 账本 | 伪造记账、重复记账、绕过冻结 | 借贷平衡校验；幂等键；冻结 / 消耗状态校验；无直接改余额接口 | 定期账实对账、journal 不可变存储、独立对账系统与告警 |
| 内部服务 | 内网横向移动后直接调用 ledger / wallet 等接口 | HMAC 签名 + 30 秒时间窗 + 调用方允许列表；默认回环监听 | mTLS 与每服务独立身份、按调用方最小权限、私网 ACL、密钥轮换 |
| 撮合通道 | 伪造下单 / 撤单 / reset 命令 | 仅回环监听 | 认证与加密通道、命令来源校验 |
| 公开行情 | 大量连接 / 订阅压垮 market-data 与 order-service | REST 查询有 `limit` 上限；网关 REST 限流 | 公共 WS 连接数与消息限流、CDN / 边缘缓存、快照去抖 |
| 私有实时流 | URL 中的 token 被日志记录后复用；跨站 WS 劫持 | Origin 白名单；会话过期断开；trader-web 不把 token 放进 URL | 禁止 query 参数认证，只允许首帧或 Cookie 认证 |
| 基础设施数据 | 默认口令、端口直接暴露 | 仅本机使用 | 强口令与密钥管理、私网、TLS、访问审计 |

## 4. 如果要走向真实环境还缺什么

按风险从高到低排列：

1. **密钥托管**：移除 `custody-adapter` 从环境变量读私钥 / 助记词的路径，改用 HSM / MPC / KMS；冷钱包真正离线签名（多签 / MPC），冷→热调拨分级审批与时间窗（当前冷热分层和水位只在 treasury 账面上实现，见 2.10 节）。
2. **服务身份**：把共享 HMAC 密钥升级为 mTLS 或每服务独立凭证，补上 `blockchain-indexer`、`custody-adapter`、`market-data-service` 的入口认证，撮合 TCP 通道加认证；所有服务显式绑定内网地址。
3. **密钥与配置管理**：所有默认密钥（内部签名密钥、API Key 加密主密钥、数据库口令）进入密钥管理系统，可轮换；演示账号与固定 TOTP 种子不能出现在任何共享环境。
4. **提现默认策略收紧**：默认强制 2FA、白名单和冷却期；审批时 step-up；引入地址风险筛查与紧急暂停开关。
5. **账号安全**：登录失败锁定与验证码、设备管理、异常登录提醒；TOTP 种子加密存储；支持 WebAuthn。
6. **Web 安全头**：CSP、`X-Frame-Options`、HSTS；Cookie 默认 `Secure`；全站 HTTPS。
7. **入口防护**：限流不信任客户端传入的 `X-Forwarded-For`；公共行情 WS 加连接与消息限流；私有 WS 去掉 query 参数认证。
8. **对账与监控**：当前的钱包 vs 账本对账基于 treasury 自己记录的持仓，还要与真实链上地址余额、托管商余额三方核对；储备不足时自动暂停提现；审计日志写入不可篡改存储。
9. **基础设施**：数据库、Redis、Kafka 走私网与 TLS，最小权限账号，备份与访问审计。
