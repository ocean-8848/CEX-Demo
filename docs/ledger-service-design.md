# Ledger Service 设计

`ledger-service` 是平台资金的唯一事实源：所有“钱从哪来、到哪去”都以双分录 journal 的形式记在这里，余额只是 journal 和冻结记录的快照。充值入账、下单冻结、撤单释放、成交结算、提币出账最终都会落到本服务的几个原语上。

- 概念入门：[../learning/05-ledger.md](../learning/05-ledger.md)
- HTTP 接口清单：[api-contracts.md](api-contracts.md#62-ledger-serviceapiv1ledgerhmac)
- outbox 事件：[event-catalog.md](event-catalog.md)
- 运行脚本与环境变量：[../services/ledger-service/README.md](../services/ledger-service/README.md)

## 1. 职责与边界

负责：

- 账户（`accounts`）与按资产的余额快照（`balances`，只有 `available` / `locked` 两列）
- 借贷平衡的 journal（`ledger_journals` + `ledger_entries`），追加写、不修改
- 冻结记录（`balance_locks`）及其释放、消耗
- 与业务写入同事务的 outbox 事件（`outbox_events`）
- 对账、单账户回放、运维告警、面向用户的资金流水

不负责：

- 业务语义：充值确认、订单撮合、手续费计算、提币审核分别在 wallet / order / settlement 中，ledger 只接收调用方组装好的 journal
- 用户与账户归属的权限判断：由 api-gateway 校验账户属于当前用户；ledger 只要求账户存在，不检查账户的 `status`
- 链上交互、托管签名、订单簿

## 2. 代码结构

| 路径 | 内容 |
| --- | --- |
| `src/application/ledger-application-service.ts` | 核心原语：`createAccount`、`postJournal`、`freezeBalance`、`releaseBalance`、`consumeBalance` 及各类查询 |
| `src/application/account-statement.ts` | 资金流水的构建规则 |
| `src/application/ledger-ops.ts` | 对账、回放、告警阈值的纯函数 |
| `src/application/ledger-outbox-publisher.ts` | outbox 发布、重试、死信 |
| `src/application/ledger-alert-remediator.ts` | 死信重排 + 循环发布 |
| `src/domain/repository.ts` | 仓储接口（含 `withTransaction`、`lockBalances`） |
| `src/domain/money.ts` | 18 位小数的定点运算（BigInt） |
| `src/infrastructure/postgres-ledger-repository.ts` | Postgres 实现 |
| `src/infrastructure/in-memory-ledger-repository.ts` | 内存实现（`LEDGER_REPOSITORY=memory`，用于单测与轻量演示） |
| `src/infrastructure/ledger-ops-reporter.ts` | 对账 / 回放 / 总览的 SQL 聚合 |
| `src/infrastructure/kafka-ledger-outbox-transport.ts` | Kafka 发布 |
| `src/scripts/*.ts` | 运维脚本，见第 11 节 |
| `sql/001_schema.sql` | 基线表结构（后续改动以更大编号的文件追加） |

## 3. 数据模型

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `accounts` | `account_id uuid`、`user_id`、`account_type`、`status` | 主键 `account_id`；账户 ID 必须是 UUID |
| `balances` | `account_id`、`asset_code`、`available numeric(36,18)`、`locked numeric(36,18)`、`version` | `unique (account_id, asset_code)` |
| `ledger_journals` | `journal_id`、`business_type`、`business_id`、`idempotency_key`、`trace_id`、`description` | `unique (idempotency_key)` |
| `ledger_entries` | `journal_id`、`account_id`、`asset_code`、`direction (debit/credit)`、`amount`、`reference_type`、`reference_id` | `amount > 0` |
| `balance_locks` | `account_id`、`asset_code`、`reference_type`、`reference_id`、`amount`、`remaining_amount`、`status`、`released_at`、`consumed_at` | `unique (reference_type, reference_id, account_id, asset_code)` |
| `outbox_events` | `event_type`、`aggregate_type`、`aggregate_id`、`payload jsonb`、`published_at`、`publish_attempts`、`last_error`、`next_attempt_at`、`dead_lettered_at` | 部分索引 `idx_outbox_events_publishable` 只覆盖未发布且未死信的行 |

几点约定：

- 金额在库里是 `numeric(36, 18)`，在代码和接口里是十进制字符串，运算统一走 `money.ts` 的 BigInt 定点（超过 18 位小数直接报错），不使用浮点
- `balances.version` 每次变更加 1，用于观察变更次数；并发控制靠行锁而不是乐观锁（见第 8 节）
- `balance_locks.amount` 是冻结时的原始金额，`remaining_amount` 是还剩多少没被释放或消耗

## 4. 账户

`accountType` 存为文本，代码中常见的取值：

| 类型 | 用途 |
| --- | --- |
| `spot` | 用户现货账户（gateway 首次访问时按 userId 稳定派生 UUID 并创建）；settlement 的平台结算账户也是 `spot` 类型 |
| `fee` | 平台手续费账户，按资产一个 |
| `opening_balance` | 期初权益账户，演示资金的来源，允许余额为负 |
| `treasury` | 演示种子创建的充值来源 / 提币去向账户 |
| `main`、`funding`、`hot_wallet`、`cold_wallet`、`withdrawal_pending` | `@web3-cex/domain` 中预留的类型，当前没有账户使用 |

**平台链上持仓不进账本**。冷热钱包分层由 wallet-service 的 treasury 模块记录（`treasury_transfers`，见 [architecture.md 5.5 节](architecture.md#55-冷热分层归集与储备金证明)）。这样设计的原因：

- 账本回答"平台欠谁多少"，treasury 回答"币在哪个钱包"。两本账独立记录，钱包 vs 账本对账才有意义；若把链上持仓也记成分录，就成了同一本账自己核对自己。
- 归集、冷热调拨都是平台内部的链上移动，不改变任何用户余额。把它们记成 `hot_wallet` / `cold_wallet` 账户之间的分录，每笔充值和提现都还要多一组对冲分录，却不会让余额对账多发现任何问题。
- 账本自身的分录对账（第 11.1 节）因此完全不受 treasury 影响，demo 中始终保持 0 差异。

账本对 treasury 只提供只读的用户负债查询（第 11.4 节）。

固定或派生的系统账户：

| 账户 | 来源 |
| --- | --- |
| `00000000-0000-0000-0000-000000000098` | 充值来源账户（`LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID`），默认也作为提币结算账户（`LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID`） |
| `00000000-0000-0000-0000-000000000090` | 期初余额账户（`LEDGER_OPENING_BALANCE_ACCOUNT_ID`） |
| `platform:spot:settlement:<asset>` 的稳定 UUID | settlement 的按资产结算中转账户 |
| `platform:spot:fee:<asset>` 的稳定 UUID | settlement 的按资产手续费账户 |

`createAccount` 是幂等的：账户已存在时只会补上缺失的 `user_id`，不改类型和状态，直接返回原记录。

## 5. 双分录与 journal

`postJournal` 的输入：

```json
{
  "businessType": "deposit_confirmed",
  "businessId": "<depositId>",
  "idempotencyKey": "deposit:<depositId>",
  "traceId": "…",
  "description": "可选",
  "entries": [
    { "accountId": "<来源账户>", "assetCode": "USDT", "direction": "debit",  "amount": "100", "referenceType": "deposit", "referenceId": "<depositId>" },
    { "accountId": "<用户账户>", "assetCode": "USDT", "direction": "credit", "amount": "100", "referenceType": "deposit", "referenceId": "<depositId>" }
  ]
}
```

规则：

1. 每条分录金额必须大于 0（`INVALID_AMOUNT`）
2. **按资产**借贷平衡：每个资产的借方合计等于贷方合计（`JOURNAL_NOT_BALANCED`）。一个 journal 可以包含多个资产，但每个资产各自平衡
3. 所有账户必须已存在（`ACCOUNT_NOT_FOUND`）
4. 同一 `idempotencyKey` 已有 journal 时：内容一致则直接返回已有 journal，不重复记账；内容不同返回 `409 DUPLICATE_IDEMPOTENCY_KEY`（细节见第 8 节“需要了解的边界”）
5. 记账方向对余额的影响：`credit` 增加 `available`，`debit` 减少 `available`。除 `opening_balance` 账户外，借记不能让 `available` 变负（`INSUFFICIENT_AVAILABLE_BALANCE`）
6. journal、分录、余额更新和一条 `ledger.journal_posted` outbox 事件在同一个数据库事务中提交

> 这里的 debit / credit 是“从哪个账户流出 / 流入哪个账户”的简化记法：debit 表示该账户余额减少，credit 表示增加。它没有区分资产类 / 负债类科目，这是学习型实现的取舍。

journal 只会被追加，不会被修改或删除；纠错需要再记一笔反向 journal。

当前代码中出现的 `businessType`：

| businessType | 记账方 | 含义 |
| --- | --- | --- |
| `deposit_confirmed` | wallet-service | 充值入账 |
| `spot_order_lock_settled` | ledger（`consumeBalance`） | 订单冻结被成交消耗，转入结算中转账户 |
| `withdrawal_settled` | ledger（`consumeBalance`） | 提币冻结被消耗，转入提币结算账户 |
| `spot_trade_settlement_base` / `spot_trade_settlement_quote` | settlement-service | 成交的 base / quote 资产交割（含手续费分录） |
| `opening_balance_backfill` | `backfill-opening-balances` 脚本 | 用期初账户补齐历史差额 |
| `seed`、`demo_seed`、`demo_simulator_topup`、`airdrop` 等 | 演示脚本 | 演示资金注入 |

## 6. 余额与冻结生命周期

一个 `(accountId, assetCode)` 的余额由两部分组成：

- `available`：可用，能被下单、提币冻结，也能被 journal 借记
- `locked`：已冻结，等待释放或消耗
- `total = available + locked`

冻结用 `(referenceType, referenceId)` 标识业务来源：订单用 `spot_order` + `orderId`，提币用 `withdrawal` + `withdrawalId`。

### 6.1 三个原语

| 操作 | 前置条件 | 余额变化 | 冻结记录变化 | outbox 事件 |
| --- | --- | --- | --- | --- |
| `freezeBalance(amount)` | `available >= amount`；同一引用没有处于 `locked` 的冻结 | `available -= amount`，`locked += amount` | 新建，`remaining = amount`，`status = locked` | `balance.locked` |
| `releaseBalance(amount?)` | 存在 `status = locked` 的冻结；`amount <= remaining`（省略则为全部剩余） | `available += amount`，`locked -= amount` | `remaining -= amount`；归零时 `status = released` 并写 `released_at` | `balance.released` |
| `consumeBalance(amount?, settlementAccountId)` | 必须给出 `settlementAccountId`；冻结处于 `locked`；`amount <= remaining` | 用户：`locked -= amount`（总额减少）；结算账户：`available += amount` | `remaining -= amount`；归零时 `status = settled` 并写 `released_at` / `consumed_at` | `ledger.journal_posted` + `balance.consumed`（`settled: true`） |

```text
                freeze
   (无记录) ───────────────▶ locked ──┬── release(全部剩余) ──▶ released
                              ▲   │    │
                              └───┘    └── consume(全部剩余) ──▶ settled
                       部分 release / 部分 consume
                       （remaining 减少，状态保持 locked）
```

`BalanceLock.status` 的类型里还保留了 `consumed`，那是早期“只减 locked、不记 journal”的消耗方式；当前代码只会产生 `settled`。资金流水和回放仍兼容历史上的 `consumed` 数据。

### 6.2 为什么消耗必须记 journal

`consumeBalance` 在一个事务里做两件事：

1. 把这部分金额从 `locked` 解冻回 `available`
2. 记一笔两条分录的 journal：用户账户 `debit`，结算账户 `credit`

净效果是用户 `locked` 减少、`available` 不变，结算账户 `available` 增加。代码里刻意没有“直接减 locked”的路径：钱离开用户必须体现为一笔借贷平衡的 journal，否则对账和回放无法解释这笔钱去了哪里。

这笔 journal 的约定：

- `businessType`：`referenceType` 为 `spot_order` 时是 `spot_order_lock_settled`，否则是 `withdrawal_settled`
- `businessId`：调用方传入的 `businessId`（成交时为 `tradeId`），缺省为 `referenceId`
- `idempotencyKey`：`<referenceType>:<referenceId>:<assetCode>:settlement:<businessId>`。同一冻结可以被不同成交多次部分消耗，每笔成交一个 journal；同一成交重试时命中已有 journal，直接返回
- 冻结已是 `settled` 时直接返回，不报错

### 6.3 幂等与重复调用

| 场景 | 结果 |
| --- | --- |
| 同一引用重复 `freeze`，且原冻结仍为 `locked` | `409 DUPLICATE_BALANCE_LOCK` |
| 同一引用重复 `freeze`，原冻结已 `released` / `settled` | 返回原冻结记录，不再冻结（唯一约束保证一个引用只有一条冻结） |
| 对不存在或已结束的冻结 `release` | `404 BALANCE_LOCK_NOT_FOUND` |
| `release` / `consume` 金额超过剩余 | `409 INVALID_BALANCE_LOCK_STATE` |
| 对已 `released` 的冻结 `consume` | `409 INVALID_BALANCE_LOCK_STATE` |
| `consume` 缺少 `settlementAccountId` | `400 SETTLEMENT_ACCOUNT_REQUIRED` |
| 同一 `idempotencyKey` 重复 `POST /journals`，内容一致（含并发） | 返回原 journal |
| 同一 `idempotencyKey` 重复 `POST /journals`，内容不同 | `409 DUPLICATE_IDEMPOTENCY_KEY` |

## 7. 典型资金流

以下用 `U` 表示用户现货账户，`T` 表示充值来源 / 提币结算账户（默认同一个 `…098`），`S(asset)` / `F(asset)` 表示平台结算中转 / 手续费账户。

### 7.1 充值

wallet 在确认数达到阈值后记账：

| 分录 | 账户 | 方向 | 金额 |
| --- | --- | --- | --- |
| 1 | `T` | debit | 充值金额 |
| 2 | `U` | credit | 充值金额 |

`businessType = deposit_confirmed`，`idempotencyKey = deposit:<depositId>`。`T` 不是 `opening_balance` 账户，余额不能为负，所以演示环境会先从期初账户给 `T` 注入流动性。

### 7.2 下单与撤单

1. order-service 先在 risk-service 拿到 `lockAssetCode` / `lockAmount`（买单冻结 quote，卖单冻结 base）
2. `freeze(U, lockAsset, lockAmount, spot_order, orderId)`
3. 撮合后无法成交的 IOC / FOK / 市价单，以及撤单、成交完成后的剩余部分，由 order-service 调 `release`（可以是部分金额）

### 7.3 成交结算

settlement-service 对一笔成交（价格 `p`、数量 `q`、quote 金额 `p*q`）依次执行：

1. `consume(卖方, base, q, spot_order, sellerOrderId, settlementAccountId = S(base), businessId = tradeId)`
2. `consume(买方, quote, p*q, spot_order, buyerOrderId, settlementAccountId = S(quote), businessId = tradeId)`
3. base 交割 journal（`spot_trade_settlement_base`，幂等键 `spot_trade:base:<tradeId>`）：

| 账户 | 方向 | 金额 |
| --- | --- | --- |
| `S(base)` | debit | `q` |
| 买方 `U` | credit | `q - 买方手续费` |
| `F(base)` | credit | 买方手续费（大于 0 才有这条） |

4. quote 交割 journal（`spot_trade_settlement_quote`，幂等键 `spot_trade:quote:<tradeId>`）：

| 账户 | 方向 | 金额 |
| --- | --- | --- |
| `S(quote)` | debit | `p*q` |
| 卖方 `U` | credit | `p*q - 卖方手续费` |
| `F(quote)` | credit | 卖方手续费（大于 0 才有这条） |

每一方用收到的资产支付手续费。结束后 `S(base)`、`S(quote)` 的净额回到 0，钱通过中转账户从一方流向另一方和手续费账户。买单按限价冻结、按成交价结算时多冻结的部分，由 order-service 在订单结束时 `release`。

### 7.4 提币

| 阶段 | 调用方 | 账本操作 |
| --- | --- | --- |
| 发起 | wallet | `freeze(U, asset, amount + fee, withdrawal, withdrawalId)` |
| 拒绝 / 失败 | wallet | `release`（全部剩余） |
| 链上确认 | wallet | `consume`（全部剩余，`settlementAccountId = T`），生成 `withdrawal_settled` journal |

## 8. 并发控制

每个写原语都在 `withTransaction` 中执行（Postgres：`begin` / `commit`，异常时 `rollback`，默认 READ COMMITTED 隔离级别）。在读取任何余额或冻结之前，先调用 `lockBalances`：

1. 把本次涉及的 `(accountId, assetCode)` 去重并按 `(accountId, assetCode)` 排序
2. `createMissing` 时先 `insert … on conflict do nothing` 插入零余额行，保证新余额也能被锁住
3. 逐行 `select … for update`

效果：

- 同一余额上的并发写互相排队，避免“读-改-写”丢失更新（例如两笔并发冻结都看到同一个 `available`）
- 固定加锁顺序，多余额事务（如 `consume` 同时锁用户和结算账户、一笔 journal 涉及多个账户）不会相互死锁
- `findBalanceLock` 在事务内也带 `for update`，同一冻结的 release / consume 串行执行

| 操作 | 加锁范围 |
| --- | --- |
| `postJournal` | journal 中所有分录的余额（`createMissing`） |
| `freezeBalance` / `releaseBalance` | 该账户该资产的余额 |
| `consumeBalance` | 用户余额 + 结算账户余额（`createMissing`） |

`src/__tests__/ledger-postgres-concurrency.test.ts` 用 20 个连接并发执行冻结、部分结算和释放，最后断言对账无差异。它需要设置 `LEDGER_TEST_DATABASE_URL` 才会运行。

需要了解的边界：

- `postJournal` 的幂等键处理（`src/application/journal-idempotency.ts`）：事务开始先查一次幂等键，拿到余额行锁后再查一次（同键请求若触及相同余额，此时先到者已提交）；分录互不相交时由 `unique (idempotency_key)` 兜底，Postgres 仓储把这个唯一冲突转换成 `DuplicateJournalIdempotencyKeyError`，事务回滚后在事务外重读胜出的 journal。三条路径最终都比较请求“指纹”（`businessType`、`businessId` 与分录集合，分录顺序和金额写法不限，`traceId` / `description` 不参与）：一致则返回原 journal，不一致返回 409 `DUPLICATE_IDEMPOTENCY_KEY`，不会出现 500。`ledger-postgres-concurrency.test.ts` 覆盖了同余额并发重放与分录不相交时的唯一冲突两种情况
- 内存仓储没有事务和行锁（`lockBalances` 为空实现，`withTransaction` 直接执行），中途失败不会回滚，只适合单测和单进程演示
- `/ops/*` 接口与运维脚本只支持 Postgres 模式

## 9. 资金流水（statement）

`GET /accounts/:accountId/statement`（gateway 对外为 `GET /api/v1/gateway/ledger/entries`）把一个账户的两类历史合并成按时间倒序的流水：

- **分录行**（`source: "entry"`）：该账户的每条 ledger entry
- **冻结行**（`source: "lock_event"`）：从 outbox 中读取该账户的 `balance.locked` / `balance.released` / `balance.consumed` 事件

每行的影响：

| 行 | `totalDelta` | `availableDelta` | `lockedDelta` |
| --- | --- | --- | --- |
| credit 分录 | `+amount` | `+amount` | 0 |
| 普通 debit 分录 | `-amount` | `-amount` | 0 |
| `spot_order_lock_settled` / `withdrawal_settled` 的 debit 分录 | `-amount` | 0 | `-amount`（钱是从冻结里出去的） |
| `balance.locked` | 0 | `-amount` | `+amount` |
| `balance.released` | 0 | `+amount` | `-amount` |
| `balance.consumed`（`settled: true`） | 不出行，对应的 journal 分录已经表达 | | |
| 历史 `balance.consumed`（无 journal） | `-amount` | 0 | `-amount` |

分类（`category`）按 `referenceType` / `businessType` 推断：`deposit`、`withdrawal`、`trade`（`spot_order`、`spot_trade`、`spot_trade_fee` 或 `spot_trade*` 业务）、其余为 `adjustment`。成交入账行会带上同一 journal 中的手续费（`feeAmount`、`feeAssetCode`），`category=fee` 过滤的就是这些行。

运行余额（`balanceAfter`）从零开始按时间正序累加，同一时刻冻结行排在分录行之前。只有当某资产累加到最后恰好等于当前 `balances` 快照时，`balanceDerivable[asset]` 才为 `true` 并返回 `balanceAfter`；否则只给流水不给余额，避免展示账本无法证明的数字。时间过滤（`from` 含、`to` 不含）和分页都在累加之后进行，所以分页不会影响运行余额的正确性。

## 10. Outbox

每个写原语在同一事务里向 `outbox_events` 写事件：

| 事件 | `aggregate_type` / `aggregate_id` | payload |
| --- | --- | --- |
| `ledger.journal_posted` | `journal` / `journalId` | `journalId`、`businessType`、`businessId`、`entryCount`、`assetCodes` |
| `balance.locked` / `balance.released` | `balance` / `<accountId>:<assetCode>` | `accountId`、`assetCode`、`referenceType`、`referenceId`、`amount` |
| `balance.consumed` | 同上 | 同上，另加 `settled: true`、`settlementAccountId` |

`payload` 列实际存为 `{ "trace_id", "occurred_at", "payload": {…} }`。

发布（`LedgerOutboxPublisher`，由 `publish-outbox` 脚本驱动）：

1. 取未发布、未死信、且 `next_attempt_at` 已到期的事件，按到期时间排序，每批默认 100 条
2. 逐条发到 Kafka 主题 `ledger.events`（key 为 `aggregate_id`，value 为整条 outbox 记录 JSON，header 带 `event_id` / `event_type` / `aggregate_type`），成功后写 `published_at`
3. 失败时 `publish_attempts + 1`，记录 `last_error`，`next_attempt_at = now + retryDelayMs × attempts`（线性退避，默认 5 s）
4. 达到最大次数（默认 5）时写 `dead_lettered_at`，并尽力把事件和失败原因发到 `dead-letter.events`；死信判定以数据库字段为准

投递语义是至少一次，消费方需要按 `event_id` 去重。

`LedgerAlertRemediator`（`drain-outbox-alerts` 脚本、`POST /ops/outbox/drain`）先把死信事件重新排队（默认开启），再循环发布直到一轮没有任何进展或达到 `maxCycles`（默认 10）。

## 11. 对账、回放与告警

这三项能力都建立在同一个事实上：`balances` 只是快照，必须能由 journal 和冻结记录重新算出来。

### 11.1 余额对账

对每个 `(accountId, assetCode)`：

```text
journalNet       = Σ credit − Σ debit                       （ledger_entries）
activeLocked     = Σ remaining_amount where status = locked （balance_locks）
expectedAvailable = journalNet − activeLocked
expectedLocked    = activeLocked
expectedTotal     = journalNet
```

与快照比较后给出 `available_mismatch` / `locked_mismatch` / `total_mismatch`。报告包含 `scannedCount`、`matchedCount`、`mismatchCount`，`includeMatched=true` 时也列出无差异的行。

### 11.2 单账户回放

`replay` 对指定账户和资产，把分录和冻结调整合并成按时间排序的步骤，从零重算 `available` / `locked`，并与快照比较（`mismatch`）。每一步都带 `availableAfter` / `lockedAfter`，方便定位从哪一步开始出现偏差。

| 步骤 | available | locked |
| --- | --- | --- |
| `entry_credit` | `+` | |
| `entry_debit` | `−` | |
| `lock` | `−` | `+` |
| `release` | `+` | `−` |
| `settle` | `+` | `−`（解冻；对应的结算 journal debit 记录流出） |
| `consume`（历史数据） | | `−` |

冻结调整优先取 outbox 中的 `balance.*` 事件（能表达部分释放 / 部分消耗的真实金额），没有事件时才退回用 `balance_locks` 行的原始金额和时间戳推断。同一时刻按 分录 → lock → release → consume/settle 的顺序处理。

### 11.3 运维总览与告警

`GET /ops/overview` 和 `check-alerts` 脚本汇总三类指标并与阈值比较，任一超阈值时 `status = "alert"` 并列出原因：

| 指标 | 默认阈值 | 环境变量 |
| --- | --- | --- |
| 待发布 outbox 数 | 100 | `LEDGER_ALERT_MAX_PENDING_OUTBOX` |
| 重试中 outbox 数 | 20 | `LEDGER_ALERT_MAX_RETRYING_OUTBOX` |
| 死信 outbox 数 | 0 | `LEDGER_ALERT_MAX_DEAD_LETTERED_OUTBOX` |
| 最老待发布事件年龄（秒） | 300 | `LEDGER_ALERT_MAX_OLDEST_PENDING_OUTBOX_AGE_SECONDS` |
| 超时冻结数（超过 `LEDGER_ALERT_STALE_LOCK_MINUTES`，默认 30 分钟） | 0 | `LEDGER_ALERT_MAX_STALE_LOCKS` |
| 对账差异数 | 0 | `LEDGER_ALERT_MAX_BALANCE_MISMATCHES` |
| `available` 为负的余额数 | 0 | `LEDGER_ALERT_MAX_NEGATIVE_AVAILABLE_BALANCES` |
| `locked` 为负的余额数 | 0 | `LEDGER_ALERT_MAX_NEGATIVE_LOCKED_BALANCES` |

ops-console 的账本页面通过 `/api/v1/ops/ledger/*` 调用这些能力；告警在 ops-console 中按 P1/P2/P3 分级（对账差异、负余额为 P1，死信、超时冻结为 P2，outbox 堆积为 P3，见 [security.md](security.md) 第 2.12 节）。

### 11.5 定时对账、委托冻结对账与熔断

ledger-service 进程内的 `ReconciliationJob`（`src/application/reconciliation-job.ts`，调度在 `src/http/reconciliation-job.service.ts`）每 `RECONCILIATION_INTERVAL_SECONDS` 秒运行一轮（代码默认 `0` 不调度；`pnpm demo:up` / `stack:start` 传入 `30`；首轮延迟 `RECONCILIATION_INITIAL_DELAY_SECONDS`，默认等于间隔），也可以通过 `POST /ops/reconciliation/jobs/run` 或 ops-console 立即运行。同一时刻只跑一轮，重复触发会合并到正在进行的那一轮。

每一轮做三件事：

1. **余额对账**：即 11.1 节，在同一个 REPEATABLE READ 快照内完成，不存在时序误差。
2. **委托冻结对账**（`src/application/order-lock-reconciliation.ts`）：打开一个 REPEATABLE READ 快照，读出全部活跃的 `spot_order` 冻结（`remaining_amount`）和各账户币种的 `locked`（拆成委托冻结与提现等其他冻结）；在快照仍打开时按冻结的委托 ID 分批（每批 ≤ 2000）调用 order-service `POST /api/v1/orders/ops/lock-expectations`，拿到每笔委托未成交部分的冻结和全部成交（每笔成交会消耗的冻结金额）；再在同一快照里按消耗 journal 的幂等键 `spot_order:<orderId>:<asset>:settlement:<tradeId>` 查出哪些成交已经被账本消耗：

   ```text
   expected = 未成交部分的冻结（买：限价 × resting，卖：resting；待触发的止损单 pending_trigger 为全部冻结）
            + 该委托中账本快照里尚未消耗的成交（买：成交价 × 数量，卖：数量）
   ```

   「是否已消耗」以账本快照为准，而不是结算服务回写给 order-service 的确认，所以确认丢失、由恢复任务补结算的成交都不会被误判。

   逐笔比较后按账户 + 币种汇总（`ledgerLocked`、`ledgerOrderLocked`、`ledgerOtherLocked`、`orderExpectedLocked`、差额）。差异类型：`lock_amount_mismatch`、`missing_ledger_lock`（委托仍需冻结但账本没有冻结）、`orphan_ledger_lock`（账本有冻结但委托不存在）。

   **在途处理**：两个服务的读取有先后（先账本快照、再 order-service），一笔委托还要经过 风控 → 冻结 → 撮合 → 落库 → 结算。以下差异算「在途」，不计入不一致：order-service 标记的 `pending_risk` / `recovery_pending`；委托 `updatedAt` 或最近一笔成交时间晚于「账本快照时间 − `RECONCILIATION_ORDER_LOCK_GRACE_SECONDS`（默认 15 秒）」；冻结创建于宽限期内。
3. **熔断判定**（`src/application/reconciliation-breaker.ts`）：余额对账不平的币种立即熔断；委托冻结对账需要**同一笔委托**连续 `RECONCILIATION_BREAKER_CONFIRMATIONS`（默认 2）轮不一致才熔断，只出现一轮记为 `suspected`（P2）。熔断调用 risk-service `POST /api/v1/risk/controls`，以 `source: "automatic"` 暂停该币种提现（已暂停时记 `already_paused`），并记录 P1 告警；`RECONCILIATION_BREAKER_ENABLED=false` 时只告警不暂停。

每轮结果写入 `ledger_reconciliation_runs`（表结构见 `sql/001_schema.sql`，保留最近 `RECONCILIATION_HISTORY_LIMIT` 条，默认 2000）：

| 状态 | 含义 |
| --- | --- |
| `ok` | 余额与委托冻结全部一致（在途差异不算） |
| `suspected` | 委托冻结有不一致，但还没达到连续轮数 |
| `mismatch` | 本轮触发了熔断（余额不平，或委托冻结连续不一致） |
| `partial` | 余额对账完成，委托冻结对账失败（如 order-service 不可用，P2） |
| `failed` | 余额对账本身失败（P2） |

熔断暂停只能人工在 ops-console「系统运维 → 紧急开关」恢复，且需要一轮晚于暂停时间、该币种一致的对账。故障实验室的「账本对账差额」实验（`POST /ops/reconciliation/lab/drift`）只在固定的实验账户 `00000000-0000-0000-0000-0000000000a1`（`account_type = fault_lab`）上写入没有分录的余额，用来演示整条链路，清除时删除该账户的余额行。

### 11.4 用户负债查询

`GET /ops/liabilities` 与 `GET /ops/liabilities/users`（`src/application/ledger-liabilities.ts`、`LedgerOpsReporter.listUserBalanceRows`）把 `accounts.user_id` 非空的账户视为用户负债，按 `available + locked` 汇总：

- 汇总：每个资产的可用、冻结、合计与持有人数，wallet-service 用它和链上储备做逐币种覆盖率对账。
- 按用户：每个用户各资产合计（只保留非零，金额规范化去掉尾随零），是储备金证明 Merkle 树的叶子来源。一个用户有多个账户时合并成一个叶子。

平台账户（期初权益、`treasury` 充值来源、结算中转、手续费）没有 `user_id`，不计入负债；它们与用户负债之和在每个资产上仍为零（双分录恒等）。

### 11.5 运维脚本

都在 `services/ledger-service` 下以 `pnpm --filter @web3-cex/ledger-service <script>` 运行，连接参数来自 `DATABASE_URL` 或 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`。

| 脚本 | 作用 | 主要环境变量 |
| --- | --- | --- |
| `db:prepare` | 构建后执行 `sql/` 下尚未记录在 `schema_migrations` 的文件（每个文件只执行一次） | |
| `publish-outbox` | 发布一批 outbox；`LEDGER_OUTBOX_RUN_FOREVER=true` 时持续轮询 | `KAFKA_BROKERS`、`LEDGER_OUTBOX_TOPIC`、`LEDGER_OUTBOX_DEAD_LETTER_TOPIC`、`LEDGER_OUTBOX_BATCH_SIZE`、`LEDGER_OUTBOX_MAX_ATTEMPTS`、`LEDGER_OUTBOX_RETRY_DELAY_MS`、`LEDGER_OUTBOX_POLL_INTERVAL_MS` |
| `drain-outbox-alerts` | 重排死信并循环发布 | `LEDGER_OUTBOX_REQUEUE_DEAD_LETTER`、`LEDGER_OUTBOX_DRAIN_MAX_CYCLES` |
| `reconcile-balances` | 输出对账报告；有差异时默认以退出码 1 结束 | `LEDGER_RECONCILE_ACCOUNT_ID`、`LEDGER_RECONCILE_ASSET_CODE`、`LEDGER_RECONCILE_INCLUDE_MATCHED`、`LEDGER_RECONCILE_FAIL_ON_MISMATCH`（默认 `true`） |
| `replay-account` | 输出单账户回放 | `LEDGER_REPLAY_ACCOUNT_ID`、`LEDGER_REPLAY_ASSET_CODE`（必填）、`LEDGER_REPLAY_FAIL_ON_MISMATCH`（默认 `false`） |
| `check-alerts` | 输出运维总览，告警时退出码 1 | `LEDGER_ALERT_*` |
| `backfill-opening-balances` | 对 `total` 与 journal 净额不一致的余额，用期初账户补一笔 `opening_balance_backfill` journal，使历史可解释 | `LEDGER_OPENING_BALANCE_ACCOUNT_ID` |
| `backfill-withdrawal-settlements` | 为历史上“只减 locked”的提币消耗补记 `withdrawal_settled` journal | `LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID` |
| `demo` | 用内置账户创建账户、记一笔 journal 并读取余额的最小演示 | `DEMO_ACCOUNT_ID`、`DEMO_PLATFORM_ACCOUNT_ID`、`DEMO_TREASURY_ACCOUNT_ID` |

## 12. 运行配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | HTTP 端口 |
| `LEDGER_REPOSITORY` | `postgres` | `memory` 切换为内存仓储（无 ops 接口） |
| `DATABASE_URL` / `PG*` | `web3:web3@127.0.0.1:5432/web3_cex` | Postgres 连接；`PGSSL=true` 开启 SSL |
| `INTERNAL_SERVICE_AUTH_SECRET` | 无 | 内部 HMAC 密钥，未配置时所有接口返回 503 |
| `INTERNAL_SERVICE_ALLOWED_CALLERS` | 见 [api-contracts.md](api-contracts.md#12-认证方式一览) | 调用方白名单 |
| `RECONCILIATION_INTERVAL_SECONDS` | `0`（演示栈 `30`） | 定时对账间隔，`0` 不调度 |
| `RECONCILIATION_INITIAL_DELAY_SECONDS` | 同间隔 | 启动后首轮延迟 |
| `RECONCILIATION_ORDER_LOCK_GRACE_SECONDS` | `15` | 委托冻结对账的在途宽限 |
| `RECONCILIATION_BREAKER_ENABLED` | `true` | 是否自动暂停提现 |
| `RECONCILIATION_BREAKER_CONFIRMATIONS` | `2` | 委托冻结不一致需连续多少轮才熔断 |
| `RECONCILIATION_HISTORY_LIMIT` | `2000` | 保留的对账记录条数 |
| `LEDGER_ORDER_SERVICE_URL` / `LEDGER_RISK_SERVICE_URL` | `http://127.0.0.1:3009` / `:3008` | 委托冻结对账与熔断调用的下游 |

所有 HTTP 接口都要求内部服务签名，外部只能经 api-gateway（用户）或 ops-console（运营）间接访问。
