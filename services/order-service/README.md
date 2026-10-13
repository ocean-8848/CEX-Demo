# Order Service

职责:

- 管理现货订单生命周期
- 调 `risk-service` 做前置校验
- 调 `ledger-service` 做下单预冻结和撤单释放
- 与 `matching-engine` 通信并处理撮合回报
- 调 `settlement-service` 完成成交后的最终结算

主链定位:

- 职责是把“下单 -> 冻结 -> 撮合 -> 成交回报 -> 触发结算”这条交易编排链稳定走通
- 学习时优先看订单状态机、成交字段和 `trade.executed` 事件，再看恢复治理
- 如果目标是解释为什么订单、撮合、结算必须分离，这个服务是主编排入口

当前实现:

- HTTP 服务，默认端口 `3009`
- PostgreSQL 持久化和数据库表结构初始化（[sql/](sql/) 下 `001`–`009` 迁移；`009` 增加 `post_only`、`stp_mode`、`trigger_price`、`triggered_at` 列）
- 主链核心能力:
  - 下单、撤单、订单查询、成交查询
  - 风控前置校验、账本预冻结、撮合桥接和成交回报处理
  - 订单簿 overview / anomalies / replay-engine
  - partial fill、market order、`gtc / ioc / fok`
  - 标准化成交执行元数据、稳定 trade event id 和跨服务回放字段
- 交易域恢复与治理:
  - recovery queue、claim lease、租约续期、独立 recovery worker
  - dead-letter 查询 / 重入队 / batch templates
  - automation execution history、schema registry / version gate、Redis Stream trade event stream
  - event-bus stream 归档 / trim / maintenance
- 订单类型:
  - `limit`（可带 `postOnly: true`，只做 Maker）
  - `market`
  - `stop_limit` / `stop_market`（必须带 `triggerPrice`）
- 自成交保护（STP）:
  - 每笔提交到引擎的订单都带 `owner_id = accountId`，可选 `stpMode`：`expire_taker`（默认）/ `expire_maker` / `expire_both`
  - 引擎返回的 `expiredMakers` 由 `expireSelfTradeMakers` 处理：挂单置为 `cancelled`、`rejectedReason = stp_expired_maker`，并按被移除的剩余量解冻资金
  - taker 被 STP 过期时：无成交则 `rejected`，部分成交后则 `cancelled`，`rejectedReason` 为 `stp_expired_taker` / `stp_expired_both`
  - 订单簿回放（replay-engine、自动 compensation replay、引擎序号恢复）会带上 `owner_id`，回放后 STP 继续生效
- Post-Only:
  - 引擎判定会立即成交时整单拒绝，订单 `rejected`、`rejectedReason = post_only_would_take`，冻结资金全部释放
- 止损单（[stop-order-trigger.ts](src/application/stop-order-trigger.ts)、[stop-order-trigger-worker.ts](src/application/stop-order-trigger-worker.ts)）:
  - 下单时照常风控、冻结资金，然后落库为 `pending_trigger`，不进入撮合引擎
  - `StopOrderTriggerWorker` 每 `ORDER_STOP_TRIGGER_POLL_INTERVAL_MS` 轮询一次：读取各市场 `pending_trigger` 订单和最新一笔成交价（即 `trade.executed` 的来源），买单 `最新价 ≥ 触发价`、卖单 `最新价 ≤ 触发价` 时触发
  - 触发用 `saveOrderIfStatus(pending_trigger → pending_risk)` 比较交换，多实例 / 重启 / 重复轮询都只提交一次；随后按 `stop_limit → limit`、`stop_market → market` 走普通撮合流程，订单 `type` 保持原值并记录 `triggeredAt`
  - 触发后的时间优先级按 `triggeredAt` 计算（引擎 `created_at` 与订单簿回放都用它）
  - 触发前撤单同样用比较交换（`pending_trigger → cancelled`），释放全部冻结资金；与触发并发时以先到者为准
  - 触发时不再调用 `risk-service`（资金在下单时已冻结）；ops 暂停市场不会阻止已挂的止损单触发
- 时效:
  - `gtc`
  - `ioc`
  - `fok`
- 下单流程:
  - risk validate
  - 订单落库为 `pending_risk`
  - ledger freeze
  - matching submit
  - 若 resting，则更新为 `accepted` 或 `partially_filled`
  - 若发生 matched，则写入稳定 execution 级 trade event，并按成交结果推进 maker / taker 状态
  - 若成交价优于 taker 限价，会释放买方多余预锁资金
- 异常处理:
  - 若撮合或结算失败且可恢复，会把订单推进到 `recovery_pending` 并写入持久化 recovery queue
  - 若撮合或结算失败且不可恢复，会释放 taker 锁定资金并把订单标记为 `rejected`
  - 若落单后 ledger 冻结失败，订单直接标记为 `rejected`（`rejectedReason` 以 `ORDER_FREEZE_FAILED:` 开头），尽力释放可能已部分写入的冻结，发布 `order.rejected`，并向调用方返回 `ORDER_FREEZE_FAILED`（上游 4xx 保留状态码，否则 502）；订单不会停留在 `pending_risk`
  - 可通过 `replay-engine` 重建指定市场订单簿
  - 可通过 `anomalies` 检测 DB 与撮合引擎快照不一致

当前限制:

- 只覆盖现货订单编排与成交闭环，不包含跨域统一 stream 框架与跨服务 consumer 自愈编排

关键状态:

- `pending_trigger`（止损单待触发）
- `pending_risk`
- `accepted`
- `partially_filled`
- `recovery_pending`
- `filled`
- `cancelled`
- `rejected`

运行脚本:

- `pnpm --filter @web3-cex/order-service build`
- `pnpm --filter @web3-cex/order-service db:prepare`
- `pnpm --filter @web3-cex/order-service recover`
- `pnpm --filter @web3-cex/order-service start`
- `pnpm --filter @web3-cex/order-service test`
- `pnpm --filter @web3-cex/order-service typecheck`

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `PORT`
- `DATABASE_URL`
- `ORDER_SERVICE_REPOSITORY`
- `RISK_SERVICE_BASE_URL`
- `LEDGER_SERVICE_BASE_URL`
- `SETTLEMENT_SERVICE_BASE_URL`
- `MATCHING_ENGINE_HOST`
- `MATCHING_ENGINE_PORT`
- `ORDER_RECOVERY_POLL_INTERVAL_MS`
- `ORDER_RECOVERY_BATCH_SIZE`
- `ORDER_RECOVERY_LEASE_RENEW_INTERVAL_MS`
- `ORDER_RECOVERY_WORKER_ID`
- `ORDER_RECOVERY_RUN_FOREVER`
- `ORDER_TRADE_EVENT_PROTOCOL_MIN`
- `ORDER_TRADE_EVENT_PROTOCOL_MAX`
- `ORDER_TRADE_EVENT_PROTOCOLS`
- `ORDER_EVENT_PUBLISHER`
- `ORDER_EVENT_CHANNEL`
- `ORDER_EVENT_REDIS_URL`
- `ORDER_EVENT_STREAM_PREFIX`
- `ORDER_EVENT_STREAM_MAX_LEN`
- `ORDER_EVENT_STREAM_RETENTION_MS`
- `ORDER_EVENT_STREAM_TRIM_COOLDOWN_MS`
- `ORDER_EVENT_STREAM_AUTO_TRIM`
- `ORDER_EVENT_STREAM_PRESSURE_WARNING_RATIO`
- `ORDER_EVENT_STREAM_LAG_WARNING_THRESHOLD`
- `ORDER_EVENT_STREAM_LAG_CRITICAL_THRESHOLD`
- `ORDER_EVENT_ARCHIVE_ENABLED`
- `ORDER_EVENT_ARCHIVE_STREAM_PREFIX`
- `ORDER_EVENT_ARCHIVE_STREAM_MAX_LEN`
- `ORDER_EVENT_STREAM_MAINTENANCE_RUN_FOREVER`
- `ORDER_EVENT_STREAM_MAINTENANCE_INTERVAL_MS`
- `ORDER_ENGINE_SYNC_INTERVAL_MS`（默认 `2000`，引擎序号落后时自动恢复序号并回放挂单）
- `ORDER_FAULT_LAB_ENABLED`（默认 `true`，故障实验室的引擎重置入口）
- `ORDER_STOP_TRIGGER_POLL_INTERVAL_MS`（默认 `1000`，止损触发轮询间隔；`0` 关闭定时器）

HTTP 接口:

- `POST /api/v1/orders`
- `POST /api/v1/orders/:orderId/cancel`
- `GET /api/v1/orders`
- `GET /api/v1/orders/:orderId`
- `GET /api/v1/trades`
- `GET /api/v1/trades/events`（成交事件列表）
- `GET /api/v1/trades/:tradeId`（单笔成交；api-gateway 用它校验成交归属）
- `POST /api/v1/trades/:tradeId/settlement`（settlement-service 回写 `settlementId`）
- `GET /api/v1/orders/ops/overview`
- `GET /api/v1/orders/ops/anomalies`
- `POST /api/v1/orders/ops/replay-engine`
- `POST /api/v1/orders/ops/stop-orders/trigger`（立即执行一轮止损触发检查；overview 返回 `pendingTriggerOrderCount` 与 `stopTrigger` 状态）
- `POST /api/v1/orders/ops/lab/engine-reset`（故障实验室：`market`、`resetSequences`；仅清空订单簿时需手动 replay-engine 修复，重置序号时由自动同步自愈，详见 [fault-lab.md](../../docs/fault-lab.md)）
- `GET /api/v1/orders/ops/recovery-jobs`
- `GET /api/v1/orders/ops/recovery-metrics`
- `GET /api/v1/orders/ops/recovery-governance`
- `GET /api/v1/orders/ops/automation-executions`
- `GET /api/v1/orders/ops/dead-letter-jobs`
- `GET /api/v1/orders/ops/dead-letter-report`
- `GET /api/v1/orders/ops/dead-letter-templates`
- `POST /api/v1/orders/ops/recovery-jobs/process`
- `POST /api/v1/orders/ops/recovery-jobs/:jobId/recover`
- `POST /api/v1/orders/ops/dead-letter-jobs/requeue`
- `POST /api/v1/orders/ops/dead-letter-jobs/:jobId/requeue`
- `GET /api/v1/orders/ops/event-bus`、`GET .../event-bus/streams`、`GET .../event-bus/streams/events`
- `POST /api/v1/orders/ops/event-bus/streams/replay`、`.../trim`、`.../maintenance`

说明:

- `order-service` 是现货交易主链的中心编排层；recovery queue 采用 claim-based worker，带 lease renewal、运行报告和 dead-letter 管理
- 成交记录带 `executionId / executionBatchId / executionSequence / replayCursor / protocolVersion`，`trade.executed` 事件使用稳定的 execution 级 `eventId`
- `trade.executed` 事件附带 `buyer/seller` 双边身份、账户和 `sellerFeeRate`，发布前经过 schema registry / version gate 校验
- 手工 `replay-engine`、自动 compensation replay 和 recovery cycle 都会写入 automation execution history
- `matching-engine` 的确定性 replay 由 Rust 内建回归集覆盖，根目录 `pnpm test:mvp` 会连同 `scripts/test-trade-domain-replay.mjs` 一起验证主链

延伸阅读:

- [06 订单与撮合](../../learning/06-order-matching.md)
- [07 清算结算与手续费](../../learning/07-clearing-settlement-fees.md)
- [事件目录](../../docs/event-catalog.md)、[故障实验室](../../docs/fault-lab.md)
