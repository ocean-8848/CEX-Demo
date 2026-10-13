# Ledger Service

职责:

- 维护双分录账本
- 管理可用余额与冻结余额
- 为所有资金变更提供审计事实源

主链定位:

- 职责是把充值入账、下单冻结、撤单释放、提币最终出账和成交结算都落成统一账务事实
- 学习时优先看 `journal / entries / balances / locks`，再看 outbox 与对账工具
- 如果目标是解释为什么账本必须和钱包、订单、结算分离，这个服务是资金事实源

关键设计:

- 账本流水 append-only
- 通过 `journal + entries` 保证借贷平衡
- 余额快照可由流水重建
- 所有资金动作必须带幂等键

核心操作（`src/application/ledger-application-service.ts`）:

- `createAccount` / `getAccount`
- `postJournal`：充值入账、成交结算、提币出账等都由调用方（wallet / settlement）以带 `businessType` 和幂等键的 journal 形式提交，账本不为每种业务单独开接口
- `freezeBalance` / `releaseBalance` / `consumeBalance`：下单与提币的冻结、释放与消耗
- `getBalance` / `listBalances` / `listJournals` / `listEntries` / `getAccountStatement`
- 用户负债（`src/application/ledger-liabilities.ts`）：`GET /api/v1/ledger/ops/liabilities` 按资产汇总 `user_id` 非空账户的 `available + locked`，`GET /api/v1/ledger/ops/liabilities/users` 按用户给出各资产合计。wallet-service 用前者做钱包 vs 账本对账、用后者构建储备金证明的 Merkle 叶子。平台链上持仓（冷热钱包）不记入账本，`hot_wallet` / `cold_wallet` 仍是保留类型，原因见 [ledger-service-design.md](../../docs/ledger-service-design.md) 第 4 节

SQL schema:

- [001_init.sql](sql/001_init.sql)
- [002_add_consumed_at_to_balance_locks.sql](sql/002_add_consumed_at_to_balance_locks.sql)
- [003_add_outbox_retry_fields.sql](sql/003_add_outbox_retry_fields.sql)
- [004_add_remaining_amount_to_balance_locks.sql](sql/004_add_remaining_amount_to_balance_locks.sql)

服务级设计:

- [ledger-service-design.md](../../docs/ledger-service-design.md)

代码骨架:

- [src/index.ts](src/index.ts)
- [src/application/ledger-application-service.ts](src/application/ledger-application-service.ts)
- [src/application/ledger-ops.ts](src/application/ledger-ops.ts)
- [src/application/ledger-outbox-publisher.ts](src/application/ledger-outbox-publisher.ts)
- [src/infrastructure/postgres-ledger-repository.ts](src/infrastructure/postgres-ledger-repository.ts)
- [src/infrastructure/ledger-ops-reporter.ts](src/infrastructure/ledger-ops-reporter.ts)
- [src/infrastructure/kafka-ledger-outbox-transport.ts](src/infrastructure/kafka-ledger-outbox-transport.ts)

运行脚本:

- `pnpm --filter @web3-cex/ledger-service db:prepare`
- `pnpm --filter @web3-cex/ledger-service demo`
- `pnpm --filter @web3-cex/ledger-service publish-outbox`
- `pnpm --filter @web3-cex/ledger-service drain-outbox-alerts`
- `pnpm --filter @web3-cex/ledger-service reconcile-balances`
- `pnpm --filter @web3-cex/ledger-service replay-account`
- `pnpm --filter @web3-cex/ledger-service check-alerts`
- `pnpm --filter @web3-cex/ledger-service backfill-withdrawal-settlements`
- `pnpm --filter @web3-cex/ledger-service backfill-opening-balances`
- `pnpm --filter @web3-cex/ledger-service start`
- `pnpm --filter @web3-cex/ledger-service test`

默认端口: `3001`

环境示例:

- [.env.example](.env.example)

`publish-outbox` 相关环境变量:

- `LEDGER_OUTBOX_TOPIC`
- `LEDGER_OUTBOX_DEAD_LETTER_TOPIC`
- `LEDGER_OUTBOX_MAX_ATTEMPTS`
- `LEDGER_OUTBOX_RETRY_DELAY_MS`
- `LEDGER_OUTBOX_BATCH_SIZE`
- `LEDGER_OUTBOX_REQUEUE_DEAD_LETTER`
- `LEDGER_OUTBOX_DRAIN_MAX_CYCLES`

`reconcile-balances` 相关环境变量:

- `LEDGER_RECONCILE_ACCOUNT_ID`
- `LEDGER_RECONCILE_ASSET_CODE`
- `LEDGER_RECONCILE_INCLUDE_MATCHED`
- `LEDGER_RECONCILE_FAIL_ON_MISMATCH`

`replay-account` 相关环境变量:

- `LEDGER_REPLAY_ACCOUNT_ID`
- `LEDGER_REPLAY_ASSET_CODE`
- `LEDGER_REPLAY_FAIL_ON_MISMATCH`

`check-alerts` 相关环境变量:

- `LEDGER_ALERT_STALE_LOCK_MINUTES`
- `LEDGER_ALERT_MAX_PENDING_OUTBOX`
- `LEDGER_ALERT_MAX_RETRYING_OUTBOX`
- `LEDGER_ALERT_MAX_DEAD_LETTERED_OUTBOX`
- `LEDGER_ALERT_MAX_OLDEST_PENDING_OUTBOX_AGE_SECONDS`
- `LEDGER_ALERT_MAX_STALE_LOCKS`
- `LEDGER_ALERT_MAX_BALANCE_MISMATCHES`
- `LEDGER_ALERT_MAX_NEGATIVE_AVAILABLE_BALANCES`
- `LEDGER_ALERT_MAX_NEGATIVE_LOCKED_BALANCES`
- `LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID`
- `LEDGER_OPENING_BALANCE_ACCOUNT_ID`

HTTP 接口:

- `POST /api/v1/ledger/accounts`
- `GET /api/v1/ledger/accounts/:accountId`
- `POST /api/v1/ledger/journals`
- `GET /api/v1/ledger/journals`
- `GET /api/v1/ledger/journals/:journalId`
- `GET /api/v1/ledger/ops/reconciliation`
- `POST /api/v1/ledger/ops/reconciliation/run`
- `GET /api/v1/ledger/ops/replay`
- `POST /api/v1/ledger/ops/replay/run`
- `GET /api/v1/ledger/ops/overview`
- `POST /api/v1/ledger/ops/outbox/drain`
- `POST /api/v1/ledger/balances/freeze`
- `POST /api/v1/ledger/balances/release`
- `POST /api/v1/ledger/balances/consume`
- `GET /api/v1/ledger/balances`
- `GET /api/v1/ledger/balances/:accountId/:assetCode`
- `GET /api/v1/ledger/accounts/:accountId/entries`
- `GET /api/v1/ledger/accounts/:accountId/statement`（客户资金流水）

资金流水（`src/application/account-statement.ts`）:

- 合并两类事实：该账户的 journal entries（资金进出）与 outbox 中的 `balance.locked / balance.released` 事件（冻结 / 解冻，只在可用与冻结之间移动）；已经由结算分录记账的 `balance.consumed(settled)` 不重复出行
- 冻结消耗分录（`withdrawal_settled`、`spot_order_lock_settled`，以及历史上 `referenceType=spot_order` 的 `withdrawal_settled`）记为「冻结减少」，其余借方记为「可用减少」
- 成交到账行附带同一 journal 中 `spot_trade_fee` 分录的手续费金额（不暴露手续费账户 id）
- 从零按时间重放得到每行的变动后余额（总额 / 可用 / 冻结）；只有重放终点与当前余额快照完全一致的资产才返回 `balanceAfter`，否则 `balanceDerivable[asset] = false`
- 过滤：`assetCode`、`category`（deposit / withdrawal / trade / adjustment / fee）、`businessType`、`includeLockEvents`、`from`（含）/ `to`（不含）、`limit`（≤200）/ `offset`；倒序返回
- 为什么不复用 `GET /journals`：流水按「账户」而不是按 `businessId` 读取，并且需要冻结事件与全历史重放，单独的只读接口更直接；按成交查看完整分录仍走 gateway 的 `listJournalsWithEntries` + `journal-view.ts`（T 型账户视图）
- 学习型 demo 每次请求读取该账户全部历史再在内存中重放，数据量大时应改为按资产分页的物化余额表

说明:

- `ledger-service` 是资金事实源，统一承接充值入账、订单冻结 / 释放、成交结算和提币最终出账。
- Kafka outbox、dead-letter、reconcile / replay 和 backfill 脚本属于运行治理部分，可在理解主链后再看。

延伸阅读:

- [05 账本](../../learning/05-ledger.md)
- [07 清算结算与手续费](../../learning/07-clearing-settlement-fees.md)
- [B04 系统对账](../../learning/backstage/B04-reconciliation.md)
