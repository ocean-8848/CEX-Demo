# Ops Console

运营后台（默认端口 `3006`）：一个 NestJS BFF（`src/`）聚合 identity / wallet / ledger / indexer / custody / order / settlement 等服务，加上一个 React 单页前端（`client/`）。

## 职责与主链定位

- 运营登录（密码 + 强制 TOTP 2FA）、基于 `identity-service` 权限点的 RBAC
- 承接用户侧发起、需要人工介入的环节：**提现审核**、充值观察人工处置、用户冻结
- 把同一笔业务在各模块的投影串起来（业务追踪），并提供账本对账、恢复队列、事件总线等运维视图
- 每个写操作都写入动作审计（操作人、权限、请求、结果）

## 页面

| 路由 | 页面 | 主要能力 |
| --- | --- | --- |
| `#/` | 运营总览 | 待审核提现（可直接批准 / 拒绝）、告警（P1/P2/P3 计数，按级别排序着色）、结算统计、账本对账结果、模块状态、待投递通知 |
| `#/withdrawals` | 提现审核 | 待审核队列（单笔 / 批量批准、拒绝）、全部提现筛选（含 KYT 风险等级筛选与风险徽标列）；高风险提现无论金额都需双人复核；详情抽屉的「地址风险（KYT）」区列出分数与命中规则；大额提现显示「1/2 已批准」与批准人，同一运营不能批准两次；详情抽屉含双人复核进度、审核要点、用户余额、审计轨迹、托管广播、用户通知 |
| `#/deposits` | 充值与链上 | 充值记录、indexer 待确认观察（确认数进度，单笔 / 批量重放、关闭） |
| `#/users` | 用户与资产 | 用户搜索（含 KYC 等级列）、冻结 / 解冻、用户详情（KYC 等级 / 事件 / 手动调整；手续费等级 / 30 日成交量 / 运营指定与指定记录；余额、委托、充提、设备与登录记录、退出设备）；「KYC 审核」页签（批准 L1 / L2、拒绝）；全局余额；提现地址簿白名单；「地址黑名单」页签（加入 / 移出必须填原因，`ops.risk.manage`，写审计；演示标签集） |
| `#/trading` | 交易与结算 | 按市场查看订单（含止损单触发价与「待触发」状态、Post-Only / STP 标记和拒绝 / 过期原因）、成交、结算（失败结算可重试）；订单簿健康（DB 与撮合引擎对比、从 DB 重建引擎订单簿） |
| `#/markets` | 市场管理 | 列出 `config/markets.json` 中的全部市场：当前状态 / 配置默认状态、步长、费率、参考价、运行时覆盖（原因 / 操作人 / 时间）；`暂停交易` / `恢复交易`（需 `ops.markets.manage`，写操作审计，经 risk-service 持久化） |
| `#/trace` | 业务追踪 | 输入 userId / orderId / tradeId / depositId / withdrawalId / accountId / txHash（或自动识别），展示跨模块链路与命中对象；后台任意蓝色 ID 都可点击跳转到这里 |
| `#/ledger` | 账本对账 | 对账（分录净额、活跃冻结、余额快照、差额）；**定时对账与熔断**（调度、最近结果、熔断暂停中的币种、历史记录与每轮的余额 / 委托冻结对账明细、「立即运行」）；账户回放（逐笔冻结 / 解冻 / 结算）、outbox 投递 |
| `#/treasury` | 钱包与储备金 | 冷热分层持仓（充值地址 / 热钱包 / 冷钱包 / 在途，热钱包水位状态）、「立即归集」「检查水位」「发起调拨」；钱包 vs 账本对账（逐币种储备、用户负债、在途提现、储备率、热钱包覆盖率）；调拨与归集记录（待审批提案可批准 / 拒绝，提案人不能批准自己的提案；失败调拨可重新广播；详情抽屉含状态历史与归集的充值）；储备金证明（生成快照、Merkle 根、逐币种储备率、历史快照） |
| `#/system` | 系统运维 | 各数据源告警（全部告警按 P1/P2/P3 排序 + 各级数量 + 各数据源最高级别）、托管路由与熔断、订单 / 结算恢复队列与死信、事件总线运行报告与手动作业、自动化作业模板与定时计划；**实验室**页签：暂停结算消费、托管广播故障、链重组、撮合引擎重置、账本对账差额五个故障实验（一键触发 / 观察 / 恢复，见 [fault-lab.md](../../docs/fault-lab.md)）；**紧急开关**页签（`#/system?tab=controls`）：全站提现暂停、API 写入冻结、单币种提现暂停（含对账熔断自动暂停的来源标记）、开关变更记录；开关需 `ops.controls.manage`（仅 `ops_admin`），两个方向都要填原因并二次确认，写入操作审计 |
| `#/audit` | 操作审计 | 后台动作审计（可展开请求 / 响应）、提现状态迁移记录 |
| `#/surveillance` | 市场监控 | 风控与运维分组下。按类型的待处理告警数、最近一次扫描；告警列表按类型 / 状态 / 市场 / userId 过滤（默认隐藏做市商）；详情抽屉显示指标、证据成交 / 撤单（ID 可跳业务追踪）、处理记录，可确认 / 忽略 / 重新打开（必须填备注，需 `ops.markets.manage`）；「立即扫描」；各市场成交参与度（做市商标为「做市商」）与当前阈值。导航上的数字是待处理告警数 |

导航、按钮按当前会话的权限点显示；无权限的操作会被隐藏或禁用，后端同样会拒绝。

## 代码结构

```text
apps/ops-console/
├── src/                      # NestJS BFF：controller / application service / 各服务 HTTP client / 审计仓储
├── client/                   # React 前端（esbuild 打包到 public/app.js）
│   ├── lib/                  # api（带 token 的 fetch）、types
│   ├── state/                # session（登录、权限、Toast、主题）、hooks（useOpsQuery / useOpsAction）
│   ├── components/           # 布局、业务组件（状态徽标、可追踪 ID、抽屉、确认弹窗…）
│   └── features/             # 每个页面一个文件
└── public/                   # index.html、styles.css（基础样式来自 @web3-cex/web-ui 的 base.css）
```

UI 基础组件、格式化工具和设计 token 与 `trader-web` 共享，位于 [packages/web-ui](../../packages/web-ui)。

## 运行

```bash
pnpm --filter @web3-cex/ops-console build     # 打包前端 + 编译 BFF
pnpm --filter @web3-cex/ops-console start
pnpm --filter @web3-cex/ops-console test      # BFF 单测
pnpm test:ops-console:local                   # 对真实全栈跑端到端：审核提现 → 链上确认 → 追踪 → 对账 → 冻结 / 解冻 → 审计
pnpm -s ops:totp                              # 打印演示运营账户当前的 TOTP 动态码
```

演示账户：`ops-admin@example.com / OpsAdminPass123!`，TOTP 种子 `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`（由 `pnpm demo:prepare` 创建）。同一个动态码只能使用一次。

第二个运营（复核人，`ops_reviewer` 角色）：`ops-reviewer@example.com / OpsReviewerPass123!`，TOTP 种子 `KRUGKIDROVUWG2ZAMJZG653OEBTG66BA`，`pnpm -s ops:totp reviewer` 打印当前动态码。超过阈值的提现先由一人批准（`first_approved`），再由另一人复核批准后才广播。

## 关键环境变量

示例见 [.env.example](.env.example)。

- `PORT`（默认 `3006`）、`OPS_CONSOLE_BIND_HOST`（默认 `127.0.0.1`）、`DATABASE_URL`
- 下游服务：`OPS_LEDGER_SERVICE_URL`、`OPS_WALLET_SERVICE_URL`、`OPS_INDEXER_SERVICE_URL`、`OPS_CUSTODY_SERVICE_URL`、`OPS_IDENTITY_SERVICE_URL`、`OPS_ORDER_SERVICE_URL`（默认 `http://127.0.0.1:3009`）、`OPS_SETTLEMENT_SERVICE_URL`（默认 `http://127.0.0.1:3010`）、`OPS_RISK_SERVICE_URL`（默认 `http://127.0.0.1:3008`，市场状态与市场监控）、`OPS_DEMO_SIMULATOR_URL`（故障实验室，默认 `http://127.0.0.1:3014`）
- 紧急开关读写走 `OPS_RISK_SERVICE_URL`，定时对账历史 / 立即运行 / 对账差额实验走 `OPS_LEDGER_SERVICE_URL`
- `OPS_CONSOLE_AUDIT_STORE`（`postgres` 默认，`memory` 可回退为内存审计）
- `OPS_ALERT_SINKS_JSON`（告警投递目标，默认 `[]`）
- `OPS_EXECUTION_SCHEDULER_RUN_FOREVER` / `OPS_EXECUTION_SCHEDULER_INTERVAL_MS` / `OPS_EXECUTION_SCHEDULER_BATCH_SIZE`（自动化作业定时计划）
- `OPS_COOKIE_SECURE`、`OPS_TRACING_UI_URL`

## HTTP 接口（节选）

- 以下路径均以 `/api/v1/ops` 为前缀
- 认证：`POST /auth/login`、`GET /auth/me`、`POST /auth/logout`
- 总览：`GET /dashboard`、`GET /modules`、`GET /alerts`（每条告警带 `severity: P1/P2/P3`，另有 `countsBySeverity`；规则在 `src/domain/alert-severity.ts`）、`GET /business-trace`
- 紧急开关（`src/http/controls.controller.ts`）：`GET /controls`；`POST /controls`（`{ scope, assetCode?, enabled, reason }`，需 `ops.controls.manage`，审计动作 `controls.<scope>.enable|disable`；恢复对账熔断暂停的币种前需要一轮一致的对账，否则 `409 RECONCILIATION_NOT_CLEAN`）
- 提现：`GET /withdrawals`、`GET /withdrawals/review-queue`、`GET /withdrawals/:id`（含审计与托管）、`POST /withdrawals/:id/approve|reject`、`POST /withdrawal-batches/approve|reject`
- 用户与资产：`GET /users`、`POST /users/:id/freeze|unfreeze`、`GET /balances`、`GET /withdrawal-address-book`
- 手续费等级：`GET /fee-tiers`、`GET /users/:id/fee-tier`（档案 + 指定记录）、`POST /users/:id/fee-tier/override`（`{ tier, note }`）、`POST /users/:id/fee-tier/override/clear`（`{ note }`）；写操作需要 `ops.users.manage`，审计动作 `fee_tier.override.set|clear`（`src/http/fees-surveillance.controller.ts`）
- 市场监控：`GET /surveillance/overview`、`GET /surveillance/alerts`、`GET /surveillance/alerts/:id`（`ops.markets.read`）；`POST /surveillance/alerts/:id/status`（`{ status, note }`）、`POST /surveillance/scan`（`ops.markets.manage`，审计动作 `surveillance.alert.acknowledge|dismiss|reopen`、`surveillance.scan`）
- 地址风险与登录安全（`src/http/ops-risk-security.controller.ts`）：`GET /risk/address-blacklist`、`POST /risk/address-blacklist`（`{ network, address, category, reason }`）、`POST /risk/address-blacklist/:entryId/remove`（`{ reason }`）、`GET /risk/address-labels`（`ops.risk.read` / `ops.risk.manage`，审计动作 `risk.blacklist.add|remove`）；`GET /users/:id/login-events`、`GET /users/:id/devices`（`ops.users.read`）、`POST /users/:id/devices/:deviceId/revoke`（`ops.users.freeze`，审计动作 `user.device.revoke`）；`GET /withdrawals` 与 `/withdrawals/review-queue` 支持 `riskLevel`
- KYC：`GET /kyc/requests`、`POST /kyc/requests/:id/approve`（`{ tier, note }`）、`POST /kyc/requests/:id/reject`（`{ reason }`）、`GET /users/:id/kyc`、`POST /users/:id/kyc-tier`（`{ tier, reason }`）；写操作需要 `ops.users.manage`，审计动作 `user.kyc.approve|reject|set_tier`
- 交易：`GET /spot/orders|trades|settlements`、`GET /spot/ops/overview|anomalies`（默认市场取 `config/markets.json` 的 `defaultMarket`）、`POST /spot/ops/replay-engine`
- 市场：`GET /market-config`（配置中的市场 / 币种，供各页下拉框使用，页面不硬编码）、`GET /markets`（含 risk-service 实时状态；risk 不可用时回退为配置默认值并标记 `statusSource: "config"`）、`POST /markets/:market/status`（`{ status: "halted" | "listed", reason }`）
- 账本：`GET /ledger/overview|reconciliation|replay`、`POST /ledger/outbox/drain`；定时对账 `GET /ledger/reconciliation/runs`、`POST /ledger/reconciliation/jobs/run`（`ops.ledger.execute`）
- 运维：恢复队列、事件总线、执行模板等见 `src/http/ops-console.controller.ts`
- 钱包与储备金（`src/http/treasury.controller.ts`）：`GET /treasury/overview|transfers|transfers/:id|reconciliation|proof-of-reserves/snapshots[/:id]`（`ops.ledger.read`）；`POST /treasury/sweeps/run`、`/treasury/watermarks/evaluate`、`/treasury/transfers`（发起提案）、`/treasury/transfers/:id/retry`、`/treasury/proof-of-reserves/snapshots`（`ops.ledger.execute`）；`POST /treasury/transfers/:id/approve|reject`（`ops.withdrawals.review`）。全部写操作以 `treasury.*` 写入操作审计
- 故障实验室（`src/http/fault-lab.controller.ts`）：`GET /lab/status`；`POST /lab/settlement/pause|resume`、`/lab/custody/inject|probe|clear`、`/lab/chain/halt|resume|seed-deposit|reorg`、`/lab/indexer/reorg-acknowledge`、`/lab/engine/reset`、`/lab/reconciliation/drift|clear`、`/lab/recover-all`。写操作需同时具备 `ops.ledger.execute`、`ops.providers.manage`、`ops.indexer.execute`（默认仅 `ops_admin`），以 `fault_lab.*` 写入操作审计

## 说明

- 内部系统，不做公网暴露；审核动作中的 `reviewedBy` 强制使用当前会话的 `userId`
- 审计记录持久化在 PostgreSQL 表 `ops_action_audit_logs`（基线 [sql/001_schema.sql](sql/001_schema.sql)；`pnpm stack:start` 自动应用，也可用 `pnpm --filter @web3-cex/ops-console db:prepare` 或根目录 `pnpm db:prepare:demo`，执行记录在 `schema_migrations`，见 [数据库结构与迁移](../../docs/getting-started.md#9-数据库结构与迁移)）

## 浏览器会话

- 前端登录时带 `x-ops-session-mode: cookie`，BFF 把 session token 写入 `ops_session` Cookie（`HttpOnly; SameSite=Strict; Path=/`，`OPS_COOKIE_SECURE=true` 时加 `Secure`），响应体不返回 token；页面脚本（包括 XSS 注入的脚本）读不到它。
- 同时下发可读的 `ops_csrf` Cookie；所有非 GET 请求必须把它放进 `x-csrf-token` 请求头（double-submit），否则 `403 Missing or invalid CSRF token`。
- 脚本与测试仍可不带该头登录，拿到 token 后用 `Authorization: Bearer` 调用；Bearer 优先于 Cookie，且不需要 CSRF 头（攻击者页面无法替浏览器附加 Authorization 头）。
- 实现：`src/http/ops-session-cookie.ts`、`src/http/ops-auth.guard.ts`、`client/lib/api.ts`。

## 延伸阅读

- [B07 应急响应](../../learning/backstage/B07-incident-response.md)、[B04 系统对账](../../learning/backstage/B04-reconciliation.md)、[B06 资金与流动性管理](../../learning/backstage/B06-treasury-liquidity.md)、[B05 业务风控](../../learning/backstage/B05-business-risk.md)
- [13 可靠性与安全事故](../../learning/13-reliability-security-incidents.md)
- [故障实验室](../../docs/fault-lab.md)、[安全设计](../../docs/security.md)
