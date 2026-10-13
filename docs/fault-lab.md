# 故障注入实验室

故障注入实验室用来在本地演示环境里制造**受控、会自动解除**的真实故障，观察交易所如何降级、告警和恢复。

入口：`ops-console` →「系统运维」→「实验室」页签，也可以直接打开 <http://127.0.0.1:3006/#/system?tab=lab>。

阅读前提：全栈已通过 `pnpm demo:up` 启动（含 `demo-simulator`），见 [getting-started.md](./getting-started.md)。页面导览见 [demo-walkthrough.md](./demo-walkthrough.md)。

## 1. 设计原则

- **开关由所属服务自己持有**。`ops-console` BFF 只负责编排、鉴权和审计：

  | 故障 | 开关所在服务 |
  | --- | --- |
  | 暂停结算消费者 | `settlement-service` |
  | 托管广播失败 | `custody-adapter` |
  | 暂停出块、链重组 | `demo-simulator`（它就是模拟链） |
  | 撮合引擎重置 | `order-service`，由它下发给 `matching-engine` |
  | 清除重组标记 | `blockchain-indexer` |
  | 账本对账差额（对账熔断） | `ledger-service`（只写实验账户），熔断开关在 `risk-service` |

- **会自动解除**。结算暂停、托管故障、暂停出块都带过期时间（页面按钮默认 2–3 分钟，服务端上限 10 分钟，下限 5 秒），到期自动解除。「一键恢复全部」可以随时清理所有实验痕迹。
- **账本保持一致**。故障只影响时序，不伪造资金流：
  - 重组深度严格小于确认阈值（默认 12，最大回退 11 块），已入账的充值永远不会被回滚。
  - 引擎重置只清空内存订单簿，数据库里的挂单和冻结资金不变。
  - 托管故障只能注入名字以 `mock-` 开头的通道，不会影响真实热钱包。
  - 对账差额只写入固定的实验账户（`account_type = fault_lab`），不涉及任何用户或平台资金；清除后对账恢复一致。
- **权限与审计**。
  - 查看实验室需要 `ops.dashboard.read`。
  - 任何触发 / 恢复动作需要同时具备 `ops.ledger.execute`、`ops.providers.manage`、`ops.indexer.execute`。默认只有 `ops_admin`（`ops-admin@example.com`）满足；其他角色看到的是只读视图。
  - 每个动作以 `fault_lab.*` 写入「操作审计」。
- **内部入口受保护**。`demo-simulator` 的 `/internal/lab/*` 要求 HMAC 内部签名，只接受调用方 `ops-console` 和 `demo-scripts`；`trader-web` 不代理这些路由。

## 2. 页面结构

实验室页签顶部是「故障注入实验室」面板：

- 市场下拉框：选择撮合引擎实验作用的市场（来自 `config/markets.json`，默认 `ETH-USDT`）。
- 刷新按钮：状态每 3 秒自动刷新一次。
- 「一键恢复全部」。
- 活动故障列表：无故障时显示「无活动故障」；有故障时列出每个故障和「自动解除」倒计时。

下面是五张实验卡片。每张卡片都有「预期现象 / 观察位置 / 恢复方式」说明、实时状态和操作按钮；右上角徽标显示「正常」「故障中」或「服务不可达」。

## 3. 五个实验

### ① 暂停结算消费者

`order-service` 把每笔成交写入 Redis Stream（`trade.executed`），`settlement-service` 作为消费者按 checkpoint 顺序结算。这个实验让消费者停下来。

| 项目 | 说明 |
| --- | --- |
| 触发 | 点「暂停结算消费（2 分钟）」 |
| 调用链 | `POST /api/v1/ops/lab/settlement/pause` → `settlement-service` `POST /api/v1/settlement/lab/consumer/pause` |
| 预期现象 | 撮合照常成交，但消费者跳过每一轮，checkpoint 不再推进。「已成交未结算」（checkpoint 与 Stream 头部的 executionSequence 之差）随做市成交持续增长。用户的订单显示已成交，但冻结资金还没有消耗、买到的资产还没有入账。此时手动「驱动结算消费一轮」会返回 `409 SETTLEMENT_EVENT_SUBSCRIBER_PAUSED`。 |
| 观察位置 | 卡片上的「已成交未结算」和「消费者」状态（已暂停 / 剩余时间 / 跳过轮数）；「系统运维」→「事件总线」的 checkpoint 滞后；`trader-web` 成交记录的「T 型账户」显示「结算中」 |
| 恢复 | 点「恢复消费」（立即触发一轮消费），或等待到期自动恢复。消费者从 checkpoint 继续读取 Stream 追平积压，滞后归零；再到「账本对账」点「重新对账」确认一致 |

这是 `trader-web`「🧭 场景导览」里「排查一次结算异常」使用的实验，完整演示步骤见 [demo-walkthrough.md](./demo-walkthrough.md#54-排查一次结算异常)。

学习章节：[../learning/07-clearing-settlement-fees.md](../learning/07-clearing-settlement-fees.md)。

### ② 托管广播连续失败

本地托管路由默认是 `mock-custody,mock-custody-backup`（未设置 `CUSTODY_PROVIDER_ORDER` 时），按优先级选择通道。这个实验让主通道持续失败，观察熔断与切换。

| 项目 | 说明 |
| --- | --- |
| 触发 | 点「注入 mock-custody 故障（3 分钟）」；再点「发送 3 笔探测广播」 |
| 调用链 | `POST /api/v1/ops/lab/custody/inject` → `custody-adapter` `POST /api/v1/custody/lab/failure-injection`；`POST /api/v1/ops/lab/custody/probe` → `POST /api/v1/custody/lab/probe-broadcast` |
| 预期现象 | `mock-custody` 每次广播都失败，健康检查报告 `unhealthy`。三笔探测依次为：失败（连续失败 1）→ 失败（连续失败达到 `CUSTODY_PROVIDER_FAILURE_THRESHOLD`，默认 2，熔断器打开）→ 路由切到 `mock-custody-backup` 并成功。故障期间真实的提现广播也会走备用通道。 |
| 观察位置 | 卡片上的「故障中」提示（已拦截次数、剩余时间）、路由表（优先级、健康、熔断器、连续失败、成功 / 失败）和探测步骤；「系统运维」→「托管通道」；「告警」页签的托管来源 |
| 恢复 | 点「清除故障并健康检查」：立即执行一次健康检查，连续失败清零、熔断闭合，路由回到主通道。不处理的话，故障到期后由下一次定时健康检查（默认 30 秒，`CUSTODY_PROVIDER_HEALTHCHECK_INTERVAL_MS`）恢复 |

探测广播不落库、不产生提现，只发往 `mock-*` 通道，但会计入路由的成功 / 失败统计。如果路由选中了真实通道，探测会停止并标记「跳过真实通道」。

归集和冷热调拨也经 `custody-adapter` 广播。故障期间如果主备通道都不可用，归集会记为 `failed` 并把充值释放回待归集池，下一轮归集（默认每 10 个块）自动重试；失败的调拨可在「钱包与储备金」页点「重新广播」。暂停出块期间模拟器也暂停归集与水位检查。

学习章节：[../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)、[../learning/13-reliability-security-incidents.md](../learning/13-reliability-security-incidents.md)。

### ③ 链重组

`demo-simulator` 每 1.5 秒出一个块。这个实验回退最近 N 个区块，模拟链重组。

| 项目 | 说明 |
| --- | --- |
| 触发 | 点「触发重组（回退 6 块）」。辅助按钮：「制造确认中充值」「暂停出块（3 分钟）」/「恢复出块」 |
| 调用链 | `POST /api/v1/ops/lab/chain/reorg` → `demo-simulator` `POST /internal/lab/chain/reorg`；辅助按钮对应 `/chain/seed-deposit`、`/chain/halt`、`/chain/resume` |
| 预期现象 | 模拟链回退最近 6 个区块，在新分叉上产生一个替换块。落在被回退区块里、尚未满确认的充值，以新的区块号和区块哈希、1 个确认重新报告给 `blockchain-indexer`；indexer 记录 `reorgDetectedAt` / `reorgedFromBlockNumber`，扫描游标带上重组标记，触发告警 `reorg_cursor_count`。随后链继续出块，充值重新累积到 12 个确认并入账。已广播但未确认的提现也会被重新放进替换块。 |
| 观察位置 | 卡片上的「区块高度」「重组次数」、「重组影响的充值」表（重组前 / 重组后的区块和确认数）和「待确认充值」表；`ops-console`「充值与链上」的确认进度；`trader-web`「充值记录」里确认数跌回 1 再重新累积；「告警」里的 indexer 来源 |
| 恢复 | 无需人工干预，充值重新确认后自动入账。核对无误后点「确认重组已处理」，调用 `blockchain-indexer` `POST /api/v1/indexer/ops/reorg/acknowledge` 清除游标上的重组标记，告警随之消失；观察记录上的重组字段作为历史保留 |

补充说明：

- 如果当前没有确认中的充值，「触发重组」会先为演示交易员（`demo-trader@example.com`）制造一笔 `0.01 ETH` 充值，保证有东西可以回滚。「制造确认中充值」按钮做同样的事，制造的充值已有 6 个确认。
- 回退深度可传 1–11，始终小于确认阈值，所以已入账充值不受影响。
- 想慢一点观察，可以先「暂停出块」：暂停期间确认数不再增长，水龙头充值会停在确认中。

学习章节：[../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)。

### ④ 撮合引擎重置

撮合引擎的订单簿只在内存里，`order-service` 的数据库是事实源。这个实验清空引擎订单簿，观察两者不一致以及如何恢复。卡片标题会显示当前选择的市场。

| 项目 | 说明 |
| --- | --- |
| 触发 | 「清空订单簿（保留序号）」或「模拟引擎重启（重置序号）」 |
| 调用链 | `POST /api/v1/ops/lab/engine/reset` → `order-service` `POST /api/v1/orders/ops/lab/engine-reset` → `matching-engine` reset（`resetSequences` 决定是否重置序号） |
| 预期现象 | 引擎订单簿被清空而数据库仍有挂单，出现 `engine_missing_open_order` 异常，盘口变薄。返回结果带重置前后的异常数。**清空订单簿（保留序号）**：序号没有回退，`order-service` 的自动同步不会察觉，必须人工修复。**模拟引擎重启（重置序号）**：引擎序号落后于数据库执行游标，自动同步（`ORDER_ENGINE_SYNC_INTERVAL_MS`，默认 2 秒）会发现并恢复序号、把挂单回放进引擎，几秒内自愈。 |
| 观察位置 | 卡片上的「引擎异常」数和「数据库挂单 / 引擎挂单」对比，以及最近一次重置的「异常 x → y」；「交易与结算」→「订单簿健康」；`trader-web` 交易页盘口 |
| 恢复 | 点「从数据库重建订单簿」（`POST /api/v1/ops/spot/ops/replay-engine`），按数据库挂单的价格和时间优先级回放进引擎，异常归零 |

学习章节：[../learning/06-order-matching.md](../learning/06-order-matching.md)。

### ⑤ 账本对账差额（对账熔断）

真实交易所「对账不平就停提币」：提币是资产离开平台的唯一出口，账对不上时先关出口再排查。这个实验制造一处账本差额，观察定时对账发现它、熔断自动暂停该币种提现，以及人工恢复的门槛。

| 项目 | 说明 |
| --- | --- |
| 触发 | 卡片上选择币种（默认 `SOL`），点「注入 SOL 差额」；再点「立即对账」，或等待下一轮定时对账（演示栈每 30 秒） |
| 调用链 | `POST /api/v1/ops/lab/reconciliation/drift` → `ledger-service` `POST /api/v1/ledger/ops/reconciliation/lab/drift`（在实验账户上写入一笔没有分录的余额）；对账任务发现不平 → `risk-service` `POST /api/v1/risk/controls`（`source: automatic`） |
| 预期现象 | 对账结果为 `mismatch`，余额对账报告实验账户 `total_mismatch`；熔断立即以「对账熔断」来源暂停该币种提现，告警页出现 P1 `RECONCILIATION_BREAKER_TRIPPED`；用户该币种的提现申请返回 `409 ASSET_WITHDRAWALS_PAUSED`，`trader-web` 提现表单被禁用；其他币种、充值和交易不受影响 |
| 观察位置 | 「账本对账」→「定时对账与熔断」的历史记录与熔断动作；「系统运维」→「紧急开关」的单币种表（来源「对账熔断」）；告警页 P1；运营总览的告警计数 |
| 恢复 | 先点「清除差额」，再「立即对账」确认结果恢复一致，最后在「系统运维」→「紧急开关」填写恢复依据并恢复该币种提现。在没有一致的对账结果前恢复会被拒绝（`409 RECONCILIATION_NOT_CLEAN`） |

学习章节：[../learning/backstage/B04-reconciliation.md](../learning/backstage/B04-reconciliation.md)、[../learning/backstage/B07-incident-response.md](../learning/backstage/B07-incident-response.md)。

## 4. 一键恢复

「一键恢复全部」调用 `POST /api/v1/ops/lab/recover-all`，按顺序执行下面的步骤，并在页面上展示每一步的结果（成功 / 失败 / 跳过）：

1. 恢复结算消费者。
2. 清除所有托管故障（含一次健康检查）。
3. 恢复出块。
4. 对每个市场检查引擎异常（`engine_missing_open_order` / `engine_orphan_order`），有异常的从数据库重建订单簿，没有的跳过。
5. 清除 indexer 游标上的重组标记。
6. 清除对账差额（没有差额时跳过）。被对账熔断暂停的提现**不会**自动恢复，需要到「紧急开关」人工恢复。

某一步失败不会中断后面的步骤，返回结果里的 `failedCount` 表示失败的步骤数。

## 5. 接口与配置速查

### 5.1 ops-console BFF

前缀 `/api/v1/ops/lab`，实现见 `apps/ops-console/src/http/fault-lab.controller.ts`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/status?market=` | 汇总五个实验的状态和活动故障 |
| `POST` | `/settlement/pause`、`/settlement/resume` | 暂停 / 恢复结算消费者（`durationSeconds`） |
| `POST` | `/custody/inject`、`/custody/probe`、`/custody/clear` | 注入托管故障（`providerName`、`durationSeconds`）、探测广播（`count`，1–10）、清除故障 |
| `POST` | `/chain/halt`、`/chain/resume`、`/chain/seed-deposit`、`/chain/reorg` | 暂停 / 恢复出块、制造确认中充值（`confirmations`）、触发重组（`depth`，1–11） |
| `POST` | `/indexer/reorg-acknowledge` | 清除 indexer 重组标记 |
| `POST` | `/engine/reset` | 重置引擎订单簿（`market`、`resetSequences`） |
| `POST` | `/reconciliation/drift`、`/reconciliation/clear` | 注入对账差额（`assetCode`、`amount`，默认 `1`）、清除差额 |
| `POST` | `/recover-all` | 一键恢复全部 |

### 5.2 各服务的实验接口与开关

| 服务 | 接口 | 环境变量（默认值） |
| --- | --- | --- |
| `settlement-service` | `GET /api/v1/settlement/lab/consumer`、`POST /api/v1/settlement/lab/consumer/pause`、`POST /api/v1/settlement/lab/consumer/resume` | `SETTLEMENT_FAULT_LAB_ENABLED`（`true`）、`SETTLEMENT_CONSUMER_PAUSE_DEFAULT_MS`（`120000`）、`SETTLEMENT_CONSUMER_PAUSE_MAX_MS`（`600000`） |
| `custody-adapter` | `GET /api/v1/custody/lab/state`、`POST /api/v1/custody/lab/failure-injection`、`POST /api/v1/custody/lab/failure-injection/clear`、`POST /api/v1/custody/lab/probe-broadcast` | `CUSTODY_FAULT_LAB_ENABLED`（`true`）、`CUSTODY_FAULT_INJECTION_DEFAULT_MS`（`180000`）、`CUSTODY_FAULT_INJECTION_MAX_MS`（`600000`）、`CUSTODY_PROVIDER_FAILURE_THRESHOLD`（`2`）、`CUSTODY_PROVIDER_HEALTHCHECK_INTERVAL_MS`（`30000`）、`CUSTODY_PROVIDER_ORDER`（`mock-custody,mock-custody-backup`） |
| `order-service` | `POST /api/v1/orders/ops/lab/engine-reset` | `ORDER_FAULT_LAB_ENABLED`（`true`）、`ORDER_ENGINE_SYNC_INTERVAL_MS`（`2000`） |
| `blockchain-indexer` | `POST /api/v1/indexer/ops/reorg/acknowledge` | — |
| `ledger-service` | `GET/POST /api/v1/ledger/ops/reconciliation/lab/drift`、`POST /api/v1/ledger/ops/reconciliation/lab/drift/clear`、`POST /api/v1/ledger/ops/reconciliation/jobs/run` | `LEDGER_FAULT_LAB_ENABLED`（`true`）、`RECONCILIATION_INTERVAL_SECONDS`（演示栈 `30`）、`RECONCILIATION_BREAKER_ENABLED`（`true`） |
| `demo-simulator` | `GET /internal/lab/status`、`POST /internal/lab/chain/halt`、`/chain/resume`、`/chain/seed-deposit`、`/chain/reorg`（均需 HMAC 内部签名） | `DEMO_FAULT_LAB_ENABLED`（`true`）、`DEMO_CHAIN_HALT_DEFAULT_MS`（`180000`）、`DEMO_CHAIN_HALT_MAX_MS`（`600000`）、`DEMO_CHAIN_BLOCK_MS`（`1500`）、`DEMO_CHAIN_REQUIRED_CONFIRMATIONS`（`12`） |
| `ops-console` | `/api/v1/ops/lab/*` | `OPS_DEMO_SIMULATOR_URL`（`http://127.0.0.1:3014`） |

把任一 `*_FAULT_LAB_ENABLED` 设为 `false`，对应服务的实验接口会拒绝请求，错误码以 `FAULT_LAB_DISABLED` 结尾（如 `SETTLEMENT_FAULT_LAB_DISABLED`、`ORDER_FAULT_LAB_DISABLED`），实验卡片会显示错误信息。

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 按钮是灰的，提示「只读」 | 当前账户不同时具备三个实验权限。用 `ops-admin@example.com` 登录 |
| 某张卡片显示「服务不可达」 | 对应服务没有运行。用 `pnpm stack:status` 检查；`demo-simulator` 也可以单独用 `pnpm demo:simulator` 启动 |
| 实验做完忘了恢复 | 点「一键恢复全部」，不需要 `pnpm demo:prepare` |
| 重组后充值一直停在确认中 | 检查是否还处于「暂停出块」状态，点「恢复出块」 |
| 清空订单簿后盘口一直不对 | 「保留序号」模式不会自愈，点「从数据库重建订单簿」 |
| 对账差额清除了，提现还是暂停 | 熔断暂停需要人工恢复：先「立即对账」得到一致结果，再到「系统运维」→「紧急开关」恢复该币种 |

更多排障思路见 [troubleshooting.md](./troubleshooting.md)。
