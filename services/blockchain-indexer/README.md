# Blockchain Indexer

职责:

- 监听链上充值与提币状态
- 处理确认数推进与链重组
- 将链上状态转成内部业务事件

主链定位:

- 职责是把“链上观测 -> 确认推进 -> 钱包入账 / 提币确认”这条异步链讲清楚
- 学习时优先看充值观测、提币观测、确认推进和扫描状态，再看回放与修复工具
- 如果目标是解释为什么链上观测要单独拆出来、为什么确认推进必须异步，这个服务是关键证据点

当前实现:

- 模拟链上充值观测 `POST /api/v1/indexer/deposits/observe`
- 根据确认数阈值调用 `wallet-service /deposits/confirm`
- 模拟链上提币观测 `POST /api/v1/indexer/withdrawals/observe`
- 根据确认数阈值调用 `wallet-service /withdrawals/confirm`
- 真实 EVM 原生币扫描 `POST /api/v1/indexer/evm/deposits/scan`
- 真实 EVM ERC-20 `Transfer` 日志扫描 `POST /api/v1/indexer/evm/deposits/scan`
- 真实 EVM 提币回执扫描 `POST /api/v1/indexer/evm/withdrawals/scan`
- `scan-evm` 调度脚本，可按配置网络循环执行一轮 deposit / withdrawal 扫描
- `replay-evm` 回放脚本，可按网络和区块范围重放一轮扫描
- `repair-backlog` 积压修复脚本，可按 cursor 回看窗口执行 deposit / withdrawal 修复
- `check-alerts` 告警脚本，可输出 cursor lag、pending observation backlog 和 reorg cursor 基线
- 通过 `GET /api/v1/indexer/deposits/:observationId` 查询观测状态
- 通过 `GET /api/v1/indexer/withdrawals/:observationId` 查询提币观测状态
- 通过 `GET /api/v1/indexer/ops/overview` 输出 backlog / lag / reorg 运维概览
- `GET /api/v1/indexer/ops/pending-deposits`：列出卡住的充值观测；`POST /api/v1/indexer/ops/pending-deposits/:observationId/replay`（可带 `confirmations` / `blockNumber` / `blockHash`）与 `POST .../close` 做人工重放或关闭，记录 `operatedBy` / `note`
- `POST /api/v1/indexer/ops/replay`：按网络和区块范围重放扫描；`POST /api/v1/indexer/ops/backlog/repair`：按回看窗口修复积压
- PostgreSQL 持久化观测记录和扫描游标
- 最小高水位管理 `GET /api/v1/indexer/cursors/:observationType/:network`
- 对非最终区块尾部做重扫，删除链重组后已消失的观测记录
- 记录同一交易更换区块号或 `block_hash` 时的链重组检测字段
- `POST /api/v1/indexer/ops/reorg/acknowledge`（`network`）：人工确认重组已处理，清除扫描游标上的重组标记（`reorg_cursor_count` 告警随之消失，观察记录上的重组字段保留）；故障实验室的链重组实验由 `demo-simulator` 触发，详见 [fault-lab.md](../../docs/fault-lab.md)
- 本地 Ganache 上可跑通原生 `ETH` 充值扫描 -> `wallet-service` 入账 -> `ledger-service` 记账

运行脚本:

- `pnpm --filter @web3-cex/blockchain-indexer db:prepare`
- `pnpm --filter @web3-cex/blockchain-indexer scan-evm`
- `pnpm --filter @web3-cex/blockchain-indexer replay-evm`
- `pnpm --filter @web3-cex/blockchain-indexer repair-backlog`
- `pnpm --filter @web3-cex/blockchain-indexer check-alerts`
- `pnpm --filter @web3-cex/blockchain-indexer start`
- `pnpm --filter @web3-cex/blockchain-indexer test`

环境示例:

- [.env.example](.env.example)

默认端口: `3003`，默认只监听 `127.0.0.1`。所有 `/api/v1/indexer/*` 接口要求内部服务 HMAC 签名，默认允许 `ops-console`、`demo-scripts`（`demo-simulator` 以此身份推送链上观测），见 `src/http/internal-service-auth.guard.ts`。

关键环境变量:

- `INTERNAL_SERVICE_AUTH_SECRET`（必填；既用于校验入站请求，也用于签名调用 `wallet-service`）
- `INTERNAL_SERVICE_ALLOWED_CALLERS`（覆盖默认调用方白名单）
- `INTERNAL_SERVICE_BIND_HOST`（默认 `127.0.0.1`）
- `BLOCKCHAIN_INDEXER_REPOSITORY`（`postgres` / `memory`）
- `WALLET_SERVICE_BASE_URL`
- `INDEXER_CONFIRMATION_THRESHOLD`（默认 `12`）
- `EVM_RPC_URL_ETHEREUM`
- `EVM_RPC_URL_BSC`
- `EVM_RPC_URL_BASE`
- `EVM_NATIVE_ASSET_CODES`
- `EVM_TOKEN_CONTRACTS`
- `INDEXER_MAX_SCAN_BLOCK_RANGE`
- `INDEXER_WALLET_PAGE_SIZE`
- `INDEXER_ENABLED_EVM_NETWORKS`
- `INDEXER_RUN_FOREVER`
- `INDEXER_SCAN_INTERVAL_MS`
- `INDEXER_REPLAY_NETWORK`
- `INDEXER_REPLAY_OBSERVATION_TYPE`
- `INDEXER_REPLAY_FROM_BLOCK`
- `INDEXER_REPLAY_TO_BLOCK`
- `INDEXER_REPAIR_NETWORK`
- `INDEXER_REPAIR_OBSERVATION_TYPE`
- `INDEXER_REPAIR_LOOKBACK_BLOCKS`
- `INDEXER_ALERT_MAX_PENDING_DEPOSITS`
- `INDEXER_ALERT_MAX_PENDING_WITHDRAWALS`
- `INDEXER_ALERT_MAX_SCAN_LAG_BLOCKS`
- `INDEXER_ALERT_MAX_STALE_CURSOR_AGE_SECONDS`
- `INDEXER_ALERT_MAX_REORG_CURSORS`

SQL schema:

- [001_init.sql](sql/001_init.sql)
- [002_add_block_hash_to_observations.sql](sql/002_add_block_hash_to_observations.sql)
- [003_add_deposit_manual_action_fields.sql](sql/003_add_deposit_manual_action_fields.sql)

说明:

- `blockchain-indexer` 在学习型 MVP 里的核心职责是解释“链上观测如何进入系统、为什么确认推进必须异步、为什么要和 wallet / ledger 分离”。
- replay、repair-backlog、cursor lag 和 reorg 告警属于扫描治理工具，可在理解主链后再看。

延伸阅读:

- [04 钱包与托管](../../learning/04-wallet-custody.md)
- [B04 系统对账](../../learning/backstage/B04-reconciliation.md)
- [故障实验室](../../docs/fault-lab.md)
