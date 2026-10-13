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
- PostgreSQL 持久化和数据库表结构初始化（[sql/](sql/) 下 `001`–`009` 迁移）
- 主链核心能力:
  - 下单、撤单、订单查询、成交查询
  - 风控前置校验、账本预冻结、撮合桥接和成交回报处理
  - 订单簿 overview / anomalies / replay-engine
  - partial fill、market order、`gtc / ioc / fok`
  - 标准化成交执行元数据、稳定 trade event id 和跨服务回放字段
- VIP 手续费等级（`src/application/fee-tier-service.ts`）:
  - 构造成交前解析 taker 和每个 maker 的等级：运营指定（`spot_fee_tier_overrides`）> `config/fee-tiers.json` 做市商计划 > 30 日成交量（`spot_trades` 中该用户作为买方或卖方、报价资产为 `volumeAsset` 的成交额）
  - 每方费率 = `min(等级费率, 市场费率)`，费率与等级写进 `spot_trades`（`buyer_fee_rate` / `buyer_fee_tier` 等）和 `trade.executed`；结算、恢复、重放只用记录值
  - 等级缓存 `ORDER_FEE_TIER_CACHE_MS`（默认 30 秒），运营指定变更立即失效；做市商计划成员在成交路径上不跑成交量汇总
  - 解析失败时退回市场默认费率（不记录等级），不会让已撮合的成交失败
  - 运营指定的设置 / 取消写 `spot_fee_tier_override_audit`
- 市场监控数据源（`src/infrastructure/surveillance-data-sources.ts`）：按时间窗口返回成交和“大额、未成交、快速撤销”的委托，供 risk-service 检测
- 交易域恢复与治理:
  - recovery queue、claim lease、租约续期、独立 recovery worker
  - dead-letter 查询 / 重入队 / batch templates
  - automation execution history、schema registry / version gate、Redis Stream trade event stream
  - event-bus stream 归档 / trim / maintenance
- 订单类型:
  - `limit`
  - `market`
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
  - 可通过 `replay-engine` 重建指定市场订单簿
  - 可通过 `anomalies` 检测 DB 与撮合引擎快照不一致

当前限制:

- 只覆盖现货订单编排与成交闭环，不包含跨域统一 stream 框架与跨服务 consumer 自愈编排

关键状态:

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
- `ORDER_FEE_TIERS_ENABLED`（默认开启；`false` 时所有成交用市场默认费率、不记录等级）
- `ORDER_FEE_TIER_CACHE_MS`（默认 `30000`）
- `WEB3_CEX_FEE_TIERS_CONFIG`（可选，替换 `config/fee-tiers.json`）

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
- `GET /api/v1/fee-tiers`（等级配置）、`GET /api/v1/fee-tiers/users/:userId`（用户等级档案）
- `POST /api/v1/fee-tiers/users/:userId/override`、`POST .../override/clear`（运营指定，`note`、`actor` 必填）
- `GET /api/v1/fee-tiers/overrides`、`GET /api/v1/fee-tiers/audit`
- `GET /api/v1/surveillance/activity`（risk-service 市场监控读取窗口数据）

说明:

- `order-service` 是现货交易主链的中心编排层；recovery queue 采用 claim-based worker，带 lease renewal、运行报告和 dead-letter 管理
- 成交记录带 `executionId / executionBatchId / executionSequence / replayCursor / protocolVersion`，`trade.executed` 事件使用稳定的 execution 级 `eventId`
- `trade.executed` 事件附带 `buyer/seller` 双边身份、账户、双方费率和 VIP 等级（`buyerFeeTier` / `sellerFeeTier`），发布前经过 schema registry / version gate 校验
- 内部调用方白名单默认包含 `risk-service`（市场监控读取成交 / 撤单窗口）
- 手工 `replay-engine`、自动 compensation replay 和 recovery cycle 都会写入 automation execution history
- `matching-engine` 的确定性 replay 由 Rust 内建回归集覆盖，根目录 `pnpm test:mvp` 会连同 `scripts/test-trade-domain-replay.mjs` 一起验证主链

延伸阅读:

- [06 订单与撮合](../../learning/06-order-matching.md)
- [07 清算结算与手续费](../../learning/07-clearing-settlement-fees.md)、[12 商业模式](../../learning/12-business-model.md)
- [事件目录](../../docs/event-catalog.md)、[故障实验室](../../docs/fault-lab.md)
