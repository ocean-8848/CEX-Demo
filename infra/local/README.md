# Local Infrastructure

本地环境只解决开发联调，不模拟生产级高可用。

组件:

- `postgres`: 核心事务数据库
- `redis`: 缓存与限流
- `kafka`: 事件总线
- `clickhouse`: 行情与分析
- `jaeger`: 链路追踪（可选，compose profile `observability`）

启动:

```bash
docker compose -f infra/local/docker-compose.yml up -d
```

启用链路追踪：

```bash
docker compose -f infra/local/docker-compose.yml --profile observability up -d
```

也可以直接用根目录 `pnpm stack:start`（或 `pnpm stack:start:observability`）一并拉起基础设施与全部服务。

默认端口:

- `postgres`: `5432`
- `redis`: `6379`
- `kafka`: `9092`
- `clickhouse`: `8123`、`9000`
- `jaeger`: `16686`（UI）、`4318`（OTLP HTTP）

默认凭据:

- `postgres`: `web3 / web3`, database `web3_cex`

建议验证命令:

```bash
docker compose -f infra/local/docker-compose.yml ps
pnpm --filter @web3-cex/ledger-service db:prepare
pnpm --filter @web3-cex/ledger-service demo
docker exec web3-cex-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
```

延伸阅读:

- [快速开始](../../docs/getting-started.md)
- [排障指南](../../docs/troubleshooting.md)
