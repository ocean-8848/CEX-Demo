# Custody Adapter

职责:

- 对接外部托管供应商或 MPC 服务
- 统一提币广播、重试和状态查询接口
- 隔离托管供应商差异，并沉淀审计记录

主链定位:

- 职责是把“审核通过后的提币广播”和“链上确认前的状态回查”从钱包状态机里拆出来
- 学习时优先看 transfer 创建、状态回查、provider 选择和 `txHash`
- 如果目标是解释为什么提币广播不能直接写在 wallet 里，这个服务就是链上执行侧证据点

当前实现:

- 支持 `mock-custody` 与 `mock-custody-backup` 两个演示 provider（未设置 `CUSTODY_PROVIDER_ORDER` 时默认按此顺序路由，主通道熔断后切到备用）
- 支持故障实验室：对 `mock-*` provider 注入自动过期的广播故障（广播失败 + 健康检查 unhealthy），发送不落库的探测广播观察熔断与路由切换，清除时立即健康检查闭合熔断，详见 [fault-lab.md](../../docs/fault-lab.md)
- 支持真实 `evm-hot-wallet` provider，可通过 RPC + 私钥或 mnemonic 广播原生币和 ERC-20 转账
- 支持按 provider 顺序和网络路由选择 provider，并在路由时自动跳过不健康或已熔断 route
- PostgreSQL 持久化 `custody_transfers` 与 `custody_transfer_attempts`
- 支持 `createTransfer`
- 支持 `retryTransfer`
- 支持 `syncTransferStatus`
- 支持 `sync-transfers` 自动回查 / 重试 worker
- 支持 provider 健康检查 worker、失败熔断、运行时路由指标和 `ops overview`
- 支持 provider SLA 统计、自动调度状态快照和 `ops report`
- 记录 `providerTransferId`、`txHash`、失败码、失败消息、重试时间和每次请求 / 响应审计

默认端口: `3004`

运行脚本:

- `pnpm --filter @web3-cex/custody-adapter db:prepare`
- `pnpm --filter @web3-cex/custody-adapter check-alerts`
- `pnpm --filter @web3-cex/custody-adapter report-ops`
- `pnpm --filter @web3-cex/custody-adapter sync-transfers`
- `pnpm --filter @web3-cex/custody-adapter start`
- `pnpm --filter @web3-cex/custody-adapter test`

HTTP 接口（全部要求内部服务 HMAC 签名，默认允许 `wallet-service`、`ops-console`、`demo-scripts`，见 `src/http/internal-service-auth.guard.ts`；默认只监听 `127.0.0.1`）:

- `POST /api/v1/custody/transfers`
- `POST /api/v1/custody/transfers/:custodyTransferId/retry`
- `POST /api/v1/custody/transfers/:custodyTransferId/sync-status`
- `GET /api/v1/custody/transfers/:custodyTransferId`
- `POST /api/v1/custody/providers/health/check`
- `GET /api/v1/custody/providers/health`
- `GET /api/v1/custody/ops/overview`
- `GET /api/v1/custody/ops/report`
- `GET /api/v1/custody/lab/state`
- `POST /api/v1/custody/lab/failure-injection`（`providerName`、`durationSeconds`）
- `POST /api/v1/custody/lab/failure-injection/clear`
- `POST /api/v1/custody/lab/probe-broadcast`（`network`、`count`）

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `INTERNAL_SERVICE_AUTH_SECRET`（必填，与调用方一致；`pnpm stack:start` 自动注入）
- `INTERNAL_SERVICE_ALLOWED_CALLERS`（覆盖默认调用方白名单）
- `INTERNAL_SERVICE_BIND_HOST`（默认 `127.0.0.1`）
- `CUSTODY_PROVIDER`
- `CUSTODY_PROVIDER_ORDER`
- `CUSTODY_PROVIDER_ORDER_BY_NETWORK`
- `CUSTODY_PROVIDER_FAILURE_THRESHOLD`
- `CUSTODY_PROVIDER_CIRCUIT_OPEN_MS`
- `CUSTODY_REPOSITORY`
- `CUSTODY_MAX_BROADCAST_ATTEMPTS`
- `CUSTODY_RETRY_DELAY_MS`
- `CUSTODY_AUTO_SYNC_ENABLED`
- `CUSTODY_AUTO_SYNC_RUN_ON_START`
- `CUSTODY_SYNC_BATCH_SIZE`
- `CUSTODY_SYNC_INTERVAL_MS`
- `CUSTODY_SYNC_RUN_FOREVER`
- `CUSTODY_SYNC_POLL_INTERVAL_MS`
- `CUSTODY_PROVIDER_HEALTHCHECK_ENABLED`
- `CUSTODY_PROVIDER_HEALTHCHECK_RUN_ON_START`
- `CUSTODY_PROVIDER_HEALTHCHECK_INTERVAL_MS`
- `CUSTODY_REPORT_WINDOW_HOURS`
- `CUSTODY_ALERT_MAX_PENDING_SYNC_COUNT`
- `CUSTODY_ALERT_MAX_RETRYABLE_COUNT`
- `CUSTODY_ALERT_MAX_FAILED_COUNT`
- `CUSTODY_ALERT_MAX_OLDEST_PENDING_SYNC_AGE_SECONDS`
- `CUSTODY_ALERT_MAX_OPEN_CIRCUIT_COUNT`
- `CUSTODY_ALERT_MAX_UNHEALTHY_ROUTE_COUNT`
- `CUSTODY_EVM_RPC_URL_ETHEREUM`
- `CUSTODY_EVM_PRIVATE_KEY_ETHEREUM`
- `CUSTODY_EVM_MNEMONIC`
- `CUSTODY_EVM_NATIVE_ASSET_CODES`
- `CUSTODY_EVM_TOKEN_CONTRACTS`
- `CUSTODY_FAULT_LAB_ENABLED`（默认 `true`）
- `CUSTODY_FAULT_INJECTION_DEFAULT_MS` / `CUSTODY_FAULT_INJECTION_MAX_MS`（默认 3 / 10 分钟）

运行说明:

- `custody-adapter` 在学习型 MVP 里的核心职责是解释“提币广播为什么要独立抽象、为什么链上回查必须异步”。
- provider SLA、熔断窗口、健康检查调度属于运行治理部分，可在理解主链后再看。

延伸阅读:

- [04 钱包与托管](../../learning/04-wallet-custody.md)
- [B06 资金与流动性管理](../../learning/backstage/B06-treasury-liquidity.md)
- [故障实验室](../../docs/fault-lab.md)
