# Settlement Service

职责:

- 消费成交结果并完成账务结算
- 消耗买卖双方的锁定资金
- 生成买卖双方 settlement journal
- 生成手续费入账

主链定位:

- 职责是把“成交发生”明确拆成“成交回报”和“最终账务结算”两个阶段
- 学习时优先看 `tradeId` 幂等结算、买卖双方锁定资金消耗和 settlement report
- 如果目标是解释为什么交易成功不等于资产已经最终入账，这个服务就是关键证据点

当前实现:

- HTTP 服务，默认端口 `3010`
- PostgreSQL 持久化和数据库表结构初始化（[sql/](sql/) 下 `001`–`007` 迁移）
- 按 `tradeId` 幂等结算
- 自动确保平台结算账户和手续费账户存在
- 主链核心能力:
  - 卖方 `base` 锁定资金消耗、买方 `quote` 按实际成交额部分消耗
  - `base / quote settlement journal` 和平台 fee account 入账
  - 结算记录查询、物化汇总驱动的 settlement report
  - `global / market / user / user_market / order / order_market` 维度汇总
  - settlementId 回写 `order-service` 成交记录
- 恢复与消费:
  - recovery jobs 查询 / 自动重试 / 单笔人工恢复 / 终态失败标记
  - lease-based recovery worker、automation execution history
  - trade event schema registry / version gate / consumer checkpoints
  - Redis Stream 驱动的 `trade.executed` 持久化消费与 replay / gap 检测

当前限制:

- 订单最终状态推进仍由 `order-service` 主导，不在 `settlement-service` 内独立完成
- report 在 `global / market / user / order` 查询下优先走物化汇总；只有 `userId + orderId` 组合过滤时才回退到原始结算记录聚合
- 不包含 stream retention、lag 观测和分层归档

运行脚本:

- `pnpm --filter @web3-cex/settlement-service build`
- `pnpm --filter @web3-cex/settlement-service db:prepare`
- `pnpm --filter @web3-cex/settlement-service start`
- `pnpm --filter @web3-cex/settlement-service test`
- `pnpm --filter @web3-cex/settlement-service typecheck`

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `PORT`
- `DATABASE_URL`
- `SETTLEMENT_REPOSITORY`
- `LEDGER_SERVICE_BASE_URL`
- `SETTLEMENT_RECOVERY_RUN_FOREVER`
- `SETTLEMENT_RECOVERY_POLL_INTERVAL_MS`
- `SETTLEMENT_RECOVERY_BATCH_SIZE`
- `SETTLEMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS`
- `SETTLEMENT_RECOVERY_WORKER_ID`
- `SETTLEMENT_TRADE_EVENT_PROTOCOL_MIN`
- `SETTLEMENT_TRADE_EVENT_PROTOCOL_MAX`
- `SETTLEMENT_TRADE_EVENT_PROTOCOLS`
- `SETTLEMENT_ORDER_SERVICE_BASE_URL`
- `SETTLEMENT_ORDER_EVENT_TRANSPORT`
- `SETTLEMENT_EVENT_REDIS_URL`
- `SETTLEMENT_EVENT_STREAM_PREFIX`
- `SETTLEMENT_EVENT_SUBSCRIBER`
- `SETTLEMENT_EVENT_SUBSCRIBER_RUN_FOREVER`
- `SETTLEMENT_EVENT_SUBSCRIBER_POLL_INTERVAL_MS`
- `SETTLEMENT_EVENT_SUBSCRIBER_BATCH_SIZE`
- `SETTLEMENT_EVENT_SUBSCRIBER_OVERLAP_COUNT`
- `SETTLEMENT_EVENT_CONSUMER_ID`
- `SETTLEMENT_FAULT_LAB_ENABLED`（默认 `true`，故障实验室开关）
- `SETTLEMENT_CONSUMER_PAUSE_DEFAULT_MS` / `SETTLEMENT_CONSUMER_PAUSE_MAX_MS`（暂停默认 / 最长时长，默认 2 / 10 分钟）

HTTP 接口:

- `POST /api/v1/settlement/trades/settle`
- `POST /api/v1/settlement/trades/:tradeId/recover`
- `GET /api/v1/settlement/trades`
- `GET /api/v1/settlement/trades/report`
- `GET /api/v1/settlement/recovery-jobs`
- `GET /api/v1/settlement/recovery-governance`
- `GET /api/v1/settlement/automation-executions`
- `POST /api/v1/settlement/events/trade-executed`
- `POST /api/v1/settlement/events/trade-executed/replay`
- `POST /api/v1/settlement/recovery-jobs/process`
- 故障实验室：`GET /api/v1/settlement/lab/consumer`（暂停状态 + 各市场「已成交未结算」滞后）、`POST /api/v1/settlement/lab/consumer/pause`（`durationSeconds`，到期自动恢复）、`POST /api/v1/settlement/lab/consumer/resume`（恢复并立即消费一轮）；暂停期间手动 `event-bus/process` 返回 `409 SETTLEMENT_EVENT_SUBSCRIBER_PAUSED`。详见 [fault-lab.md](../../docs/fault-lab.md)
- `GET /api/v1/settlement/event-bus`、`GET /api/v1/settlement/event-bus/checkpoints`、`POST /api/v1/settlement/event-bus/process`（consumer 状态、checkpoint 与手动消费一轮）

说明:

- `settlement-service` 支撑交易主链，具备 recovery / retry / terminal failure / manual recover 与物化汇总 report
- recovery queue 带 claim lease、租约续期、运行报告和 automation execution history
- 事件消费侧带 schema registry / version gate / consumer checkpoint，默认通过 Redis Stream subscriber 消费 `trade.executed`
- subscriber 带 overlap replay 窗口，以便在 settlement 已完成但 settlementId 回写失败时自动重试 acknowledgement

延伸阅读:

- [07 清算结算与手续费](../../learning/07-clearing-settlement-fees.md)
- [05 账本](../../learning/05-ledger.md)
- [事件目录](../../docs/event-catalog.md)、[故障实验室](../../docs/fault-lab.md)
