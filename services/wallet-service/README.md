# Wallet Service

职责:

- 管理充值地址分配
- 管理提币申请、审核状态、白名单地址
- 管理充值确认入账与提币通知（不包含冷热钱包与归集管理）
- 提现地址风险（简化 KYT）：规则评分、地址黑名单、高风险双人复核
- 承载账户安全站内信（identity-service 写入的 `security.new_device_login`）

主链定位:

- 职责是把“充值地址 -> 充值入账 -> 提币申请 -> 审核 -> 广播 -> 确认”这条钱包状态机讲清楚
- 学习时优先看充值地址、提币状态、审核状态和通知，再看 worker 治理
- 如果目标是解释为什么充值 / 提币必须异步推进、为什么钱包和账本要分离，这个服务是主入口

关键接口:

- `createDepositAddress`
- `confirmDeposit`
- `listDeposits`
- `requestWithdrawal`
- `approveWithdrawal`
- `rejectWithdrawal`
- `createWithdrawalAddressBookEntry`
- `listWithdrawalAddressBookEntries`
- `whitelistWithdrawalAddress`
- `unwhitelistWithdrawalAddress`

通知事件（`wallet_notifications`，并通过 Redis `web3-cex:wallet.notifications` 发布）:

- `withdrawal.requested`
- `withdrawal.approved`
- `withdrawal.rejected`
- `withdrawal.broadcasted`
- `withdrawal.confirmed`
- `deposit.credited`
- `security.new_device_login`（不关联提币 / 充值，由 identity-service 通过 `POST /notifications/security` 写入）

提币审计动作（`withdrawal_audit_logs`）: `requested` / `first_approved` / `approved` / `rejected` / `broadcasted` / `confirmed`（KYT 自动拒绝的操作人为 `system:kyt`）

SQL schema:

- [001_init.sql](sql/001_init.sql)
- [002_add_ledger_columns.sql](sql/002_add_ledger_columns.sql)
- [003_add_withdrawal_ledger_columns.sql](sql/003_add_withdrawal_ledger_columns.sql)
- [004_add_withdrawal_tx_hash_index.sql](sql/004_add_withdrawal_tx_hash_index.sql)
- [005_add_wallet_query_indexes.sql](sql/005_add_wallet_query_indexes.sql)
- [006_add_withdrawal_audit_and_notifications.sql](sql/006_add_withdrawal_audit_and_notifications.sql)
- [007_add_notification_delivery_fields.sql](sql/007_add_notification_delivery_fields.sql)
- [008_add_notification_read_state_and_deposit_events.sql](sql/008_add_notification_read_state_and_deposit_events.sql)（`read_at` 已读标记、`deposit_id` + `deposit.credited` 事件）
- [009_add_dual_approval_audit_action.sql](sql/009_add_dual_approval_audit_action.sql)（审计动作新增 `first_approved`，地址簿按用户 + 创建时间索引）
- [010_add_withdrawal_risk_and_address_blacklist.sql](sql/010_add_withdrawal_risk_and_address_blacklist.sql)（提现 `risk_score / risk_level / risk_reasons`、`withdrawal_address_blacklist` 及 3 个演示种子、`security.*` 通知类型）

运行脚本:

- `pnpm --filter @web3-cex/wallet-service db:prepare`
- `pnpm --filter @web3-cex/wallet-service deliver-notifications`
- `pnpm --filter @web3-cex/wallet-service reconcile-stale-withdrawals`
- `pnpm --filter @web3-cex/wallet-service start`
- `pnpm --filter @web3-cex/wallet-service test`

HTTP 接口:

- `POST /api/v1/wallet/deposit-addresses`
- `GET /api/v1/wallet/deposit-addresses`
- `POST /api/v1/wallet/withdrawal-address-book`
- `GET /api/v1/wallet/withdrawal-address-book`
- `POST /api/v1/wallet/withdrawal-address-book/:addressBookId/whitelist`
- `POST /api/v1/wallet/withdrawal-address-book/:addressBookId/unwhitelist`
- `GET /api/v1/wallet/deposits`
- `POST /api/v1/wallet/deposits/confirm`
- `GET /api/v1/wallet/deposits/:depositId`
- `POST /api/v1/wallet/withdrawals/validate`
- `GET /api/v1/wallet/withdrawal-limits?userId=`（KYC 等级、各币种有效单笔 / 每日限额、今日已用 / 剩余、双人复核阈值、冷却期状态）
- `GET /api/v1/wallet/withdrawals`
- `POST /api/v1/wallet/withdrawals/request`
- `GET /api/v1/wallet/withdrawals/review-queue`
- `GET /api/v1/wallet/withdrawals/:withdrawalId`
- `GET /api/v1/wallet/withdrawals/:withdrawalId/audit-logs`
- `GET /api/v1/wallet/audit-logs`
- `POST /api/v1/wallet/withdrawals/confirm`
- `GET /api/v1/wallet/notifications`（支持 `depositId`、`readState=read|unread` 过滤）
- `GET /api/v1/wallet/notifications/unread-count?userId=`
- `POST /api/v1/wallet/notifications/read`（body `{ userId, notificationIds? }`；省略 `notificationIds` = 该用户全部已读）
- `POST /api/v1/wallet/ops/notifications/deliver`
- `POST /api/v1/wallet/ops/withdrawals/reconcile-stale`
- `POST /api/v1/wallet/withdrawals/:withdrawalId/approve`
- `POST /api/v1/wallet/withdrawals/:withdrawalId/reject`
- `GET /api/v1/wallet/risk/address-blacklist?status=&network=&address=&category=`
- `POST /api/v1/wallet/risk/address-blacklist`（`{ network, address, category, reason, createdBy? }`，返回 `{ entry, autoRejectedWithdrawalIds }`）
- `POST /api/v1/wallet/risk/address-blacklist/:entryId/remove`（`{ reason, removedBy? }`）
- `GET /api/v1/wallet/risk/address-labels`
- `POST /api/v1/wallet/notifications/security`（identity-service 专用）
- `GET /withdrawals` 与 `/withdrawals/review-queue` 支持 `riskLevel=low|medium|high|blocked`

当前提币流:

- 简化 KYT 先于其他规则执行（`src/domain/withdrawal-risk.ts`，纯函数；单测 `src/__tests__/withdrawal-risk.test.ts`）：
  - 黑名单命中 → `blocked`：`validate` 与 `request` 都返回 `403 WITHDRAWAL_ADDRESS_BLOCKED`；`request` 另外保存一条 `rejected` 记录（`riskLevel=blocked`、`frozenAmount=0`、审计操作人 `system:kyt`）并发 `withdrawal.rejected` 通知
  - 演示标签（混币 / 高风险 / 博彩，`DEMO_ADDRESS_RISK_LABELS` + `WITHDRAWAL_RISK_ADDRESS_LABELS`）+70；白名单或该用户曾成功提现到此地址 → 不加分；否则首次地址 +10、首次且金额 > `WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET` +40、地址簿条目新于 `WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS` +30
  - ≥60 `high`（审批策略固定为 2 人，`approvalPolicy.reason = "risk_high"`），≥30 `medium`，其余 `low`；分数、等级、原因写入 `withdrawals.risk_*`，`validate` 响应带 `risk`
  - 加入黑名单时立即扫描发往该地址的 `pending / pending_second_approval` 提现：释放冻结、改为 `rejected`、通知用户；批准时也会再查黑名单，命中则自动拒绝并返回 `WITHDRAWAL_ADDRESS_BLOCKED`
  - 评分放在 wallet-service：地址簿、历史提现、黑名单都是钱包自有数据，而且必须在冻结前同步判定，不值得为此增加一次到 risk-service 的同步调用
- 可选新设备提现锁：`WITHDRAWAL_NEW_DEVICE_LOCK_SECONDS > 0` 时读取 identity `GET /users/:id/login-security` 的 `lastNewDeviceLoginAt`，窗口内返回 `403 WITHDRAWAL_NEW_DEVICE_LOCK`；`/withdrawal-limits` 同时返回 `newDeviceLock`

- `validateWithdrawalRequest` 会校验地址格式、最小提币额、最小手续费、白名单、单笔限额、日累计限额和 `identity-service` 中的 2FA 启用状态
- `requestWithdrawal` 会调用 `identity-service /two-factor/verify` 做真实 TOTP 校验，再调用 `ledger-service /balances/freeze`
- `approveWithdrawal` 会调用 `custody-adapter /transfers` 并把提币单推进到 `broadcasted`；金额严格大于双人复核阈值时，第一次批准只把单子推进到
  `under_review / pending_second_approval`（审计 `first_approved`），必须由另一名运营（不同 `reviewedBy`）再次批准才广播，同一人重复批准返回 `409 WITHDRAWAL_SAME_APPROVER`
- 规则全部集中在纯函数模块 `src/domain/withdrawal-policy.ts`（KYC 限额表、当日额度、双人复核状态机、冷却期），单元测试见 `src/__tests__/withdrawal-policy.test.ts` 与 `withdrawal-security.test.ts`
- KYC：申请时从 `identity-service /users/:id/kyc` 读取等级，有效限额 = min(平台限额, 等级限额)；当日额度按 UTC 自然日统计非 failed / rejected 的提现
- 2FA：用户开启 2FA 后每次提现都必须带动态码（不论 `WITHDRAWAL_REQUIRE_2FA`）；`WITHDRAWAL_REQUIRE_2FA=true` 时未开启 2FA 返回 `WITHDRAWAL_2FA_NOT_ENABLED`；动态码最后校验，被其他规则拒绝的请求不会消耗动态码
- 冷却期：最近一次新增地址簿地址或开启 / 关闭 2FA 后 `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS` 内返回 `403 WITHDRAWAL_SECURITY_COOLDOWN`，消息含 `remainingSeconds=N`
- `confirmWithdrawal` 会按 `network + txHash` 查找提币单，并在确认数达阈值后调用 `ledger-service /balances/consume`
- `rejectWithdrawal` 会调用 `ledger-service /balances/release`
- `requestWithdrawal`、`approveWithdrawal`、`rejectWithdrawal`、`confirmWithdrawal` 会写 `withdrawal_audit_logs`
- `requestWithdrawal`、`approveWithdrawal`、`rejectWithdrawal`、`confirmWithdrawal` 会写 `wallet_notifications`
- `deliver-notifications` 会消费 `wallet_notifications` 中的 pending 记录并更新送达状态 / 重试信息
- 充值入账（`confirmDeposit` 达到确认阈值并写入账本）会在同一事务里写一条 `deposit.credited` 通知；部分唯一索引 `(deposit_id, event_type)` 保证 indexer 重放回调不会重复通知
- 已读标记（`read_at`）放在 `wallet_notifications` 上，而不是 gateway 自建存储，原因:
  - 通知本来就由 wallet 生产和持有，已读是同一行的属性；未读数是一条带部分索引（`where read_at is null`）的单表查询，不需要跨服务 join
  - gateway 保持无状态（只有 Redis 限流 / 幂等缓存），不必为一个标记引入新的持久化与迁移
  - 已读只影响客户可见状态，与投递状态（`status` = pending / delivered / failed）相互独立，送达 worker 不读也不改 `read_at`
  - 归属校验在 wallet 内完成：按 id 标记时任何不属于该 `userId` 的 id 一律返回 `404 NOTIFICATION_NOT_FOUND`（不泄露存在性），批量更新的 SQL 也带 `user_id = $1` 条件
- `reconcile-stale-withdrawals` 会按状态对陈旧提币单执行 reject / rebroadcast / confirm，帮助清理资金层 stale lock
- 地址白名单通过 `withdrawal-address-book` 接口创建、查询和切换状态

默认端口: `3002`

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `LEDGER_SERVICE_BASE_URL` / `CUSTODY_ADAPTER_BASE_URL`
- `DEPOSIT_CONFIRMATION_THRESHOLD` / `WITHDRAWAL_CONFIRMATION_THRESHOLD`（默认 `12`）
- `WITHDRAWAL_REQUIRE_2FA`
- `WITHDRAWAL_REQUIRE_WHITELIST`
- `IDENTITY_SERVICE_BASE_URL`
- `WITHDRAWAL_MIN_AMOUNT_BY_ASSET`
- `WITHDRAWAL_MIN_FEE_BY_NETWORK`
- `WITHDRAWAL_SINGLE_LIMIT_BY_ASSET`
- `WITHDRAWAL_DAILY_LIMIT_BY_ASSET`
- `WITHDRAWAL_KYC_LIMITS_ENABLED`（默认 `true`，`false` 关闭等级限额）
- `WITHDRAWAL_KYC_LIMITS_UNVERIFIED` / `WITHDRAWAL_KYC_LIMITS_L1` / `WITHDRAWAL_KYC_LIMITS_L2`（格式 `USDT=单笔/每日,ETH=...`，覆盖默认表；默认 USDT：未认证 `1000/2000`、L1 `10000/20000`、L2 `100000/200000`；ETH：`0.5/1`、`5/10`、`50/100`；BTC：`0.02/0.05`、`0.2/0.5`、`2/5`）
- `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_BY_ASSET`（默认 `USDT=5000,USDC=5000,ETH=2,BTC=0.1,SOL=50`；设为空字符串关闭双人复核）
- `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS`（代码默认 `86400` 即 24 小时；`pnpm stack:start` 默认传 `0`，演示时 `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS=120 pnpm stack:start`）
- `WITHDRAWAL_RISK_ENABLED`（默认 `true`）/ `WITHDRAWAL_RISK_LARGE_AMOUNT_BY_ASSET`（默认 `USDT=1000,USDC=1000,ETH=0.5,BTC=0.02,SOL=10`）/ `WITHDRAWAL_RISK_NEW_ADDRESS_WINDOW_SECONDS`（默认 `86400`）/ `WITHDRAWAL_RISK_ADDRESS_LABELS`（追加标签，`0x…=mixer|high_risk|gambling|darknet`）
- `WITHDRAWAL_NEW_DEVICE_LOCK_SECONDS`（默认 `0` 关闭）
- `WALLET_EVENT_PUBLISHER` / `WALLET_REDIS_URL` / `WALLET_NOTIFICATION_EVENT_CHANNEL`
- `WALLET_NOTIFICATION_BATCH_SIZE`
- `WALLET_NOTIFICATION_MAX_ATTEMPTS`
- `WALLET_NOTIFICATION_RETRY_DELAY_MS`
- `WALLET_NOTIFICATION_RUN_FOREVER`
- `WALLET_NOTIFICATION_POLL_INTERVAL_MS`
- `WALLET_STALE_WITHDRAWAL_MINUTES`
- `WALLET_STALE_WITHDRAWAL_BATCH_SIZE`
- `WALLET_STALE_REBROADCAST_AUTO_CONFIRM`
- `WALLET_STALE_BROADCAST_CONFIRMATIONS`
- `WALLET_STALE_BROADCAST_BLOCK_NUMBER`
- `WALLET_STALE_WITHDRAWAL_OPERATOR_ID`

说明:

- `wallet-service` 在学习型 MVP 里的核心职责是解释“充值 / 提币为什么是状态机、为什么审核和链上确认必须异步推进”。
- notification worker 和 stale withdrawal reconcile 属于资金侧运行治理，可在理解主链后再看。

延伸阅读:

- [04 钱包与托管](../../learning/04-wallet-custody.md)
- [B06 资金与流动性管理](../../learning/backstage/B06-treasury-liquidity.md)
- [安全设计](../../docs/security.md)
