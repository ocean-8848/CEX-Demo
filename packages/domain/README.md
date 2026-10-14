# @web3-cex/domain

所有 Node 服务、BFF 和演示脚本共享的领域类型与工具库，没有运行时依赖。

- `src/index.ts`：核心领域类型（`Order` / `Trade` / `Deposit` / `Withdrawal` / `LedgerEntry`、`OrderStatus`、`TimeInForce` 等）、交易事件 envelope 与 `trade.executed` schema registry / version gate，以及服务间调用的 HMAC 签名工具（`createInternalServiceAuthHeaders` / `verifyInternalServiceSignature`）
- `src/decimal.ts`：基于 `bigint` 的 18 位定点小数运算（加减乘除、比较、步长对齐），金额一律以十进制字符串在服务间传递
- `src/market-config.ts`：读取并校验 [config/markets.json](../../config/markets.json)（`parseMarketConfig` / `loadMarketConfig`），导出 `MARKET_CATALOG` / `MARKET_CONFIG`；可用 `WEB3_CEX_MARKETS_CONFIG` 指向另一份配置，配置不合法时进程拒绝启动
- `src/schema-migrations.ts`（以 `@web3-cex/domain/schema-migrations` 引入，仅限 Node，不从包根导出）：各服务 `db:prepare` 共用的前向迁移 runner。在 advisory lock 下按文件名顺序执行服务 `sql/` 中尚未记录的文件，每个文件一个事务，记入 `schema_migrations(service, version, checksum, applied_at)`；已执行文件被修改（checksum 不一致）或发现未记录的旧表时报错并提示 `pnpm db:reset`，见 [数据库结构与迁移](../../docs/getting-started.md#9-数据库结构与迁移)

运行:

```bash
pnpm --filter @web3-cex/domain build
pnpm --filter @web3-cex/domain test
```

各服务的 `prebuild` 会自动先构建本包。

延伸阅读:

- [领域模型](../../docs/domain-model.md)、[事件目录](../../docs/event-catalog.md)
- [市场与币种配置](../../config/README.md)
