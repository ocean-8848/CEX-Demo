# Market Data Service

职责:

- 基于订单 / 成交快照聚合 `ticker`、`depth`、`recent trades`
- 订阅交易事件并向公共 WebSocket 广播市场数据更新
- 提供 K 线、统计指标和分析落盘的行情入口

主链定位:

- 职责是把订单 / 成交域里的内部事实转成用户可见的公共行情读模型
- 学习时优先看 `ticker / depth / recent trades / ws`
- 如果目标是解释为什么行情必须独立于订单和撮合，这个服务就是公共市场视图入口

当前实现:

- HTTP 服务，默认端口 `3012`
- REST:
  - `GET /api/v1/market-data/tickers`
  - `GET /api/v1/market-data/ticker?market=...`
  - `GET /api/v1/market-data/depth?market=...&limit=...`
  - `GET /api/v1/market-data/trades?market=...&limit=...`
  - `GET /api/v1/market-data/klines?market=...&interval=...&limit=...`
  - `GET /api/v1/market-data/analytics?market=...`
- 公共 WebSocket:
  - `WS /api/v1/market-data/ws`
- 通过 Redis 订阅 `web3-cex:trading.events`
- 根据 `order-service` 的 open orders / trades 快照构建 `ticker`、`depth`、`recent trades`
- 把 `ticker / depth / recent trades` 快照写入 Redis
- 把行情快照和成交分析行写入 ClickHouse
- 首次写入或查询时在 ClickHouse 创建（`create ... if not exists`） `1m / 5m / 15m / 1h / 4h / 1d / 1w` K 线聚合表和物化视图
- 支持长周期 K 线查询和 analytics 视图（建表逻辑见 [src/infrastructure/market-data-clickhouse.ts](src/infrastructure/market-data-clickhouse.ts)）

当前限制:

- 查询优先读 ClickHouse 聚合视图，降级时回退服务内重建
- analytics 以单市场摘要为主，不包含跨市场横向统计视图

运行脚本:

- `pnpm --filter @web3-cex/market-data-service build`
- `pnpm --filter @web3-cex/market-data-service start`
- `pnpm --filter @web3-cex/market-data-service test`
- `pnpm --filter @web3-cex/market-data-service typecheck`

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `PORT`
- `MARKET_DATA_ORDER_SERVICE_URL`
- `MARKET_DATA_EVENT_SUBSCRIBER`
- `MARKET_DATA_REDIS_URL`
- `MARKET_DATA_REDIS_PREFIX`
- `MARKET_DATA_EVENT_CHANNEL`
- `MARKET_DATA_SNAPSHOT_STORE`
- `MARKET_DATA_SNAPSHOT_TTL_SECONDS`
- `MARKET_DATA_TICKER_WINDOW_MS`
- `MARKET_DATA_DEPTH_SNAPSHOT_LIMIT`
- `MARKET_DATA_TRADE_SNAPSHOT_LIMIT`
- `MARKET_DATA_ANALYTICS_SINK`
- `MARKET_DATA_CLICKHOUSE_URL`
- `MARKET_DATA_CLICKHOUSE_DATABASE`
- `MARKET_DATA_CLICKHOUSE_USER`
- `MARKET_DATA_CLICKHOUSE_PASSWORD`
- `MARKET_DATA_CLICKHOUSE_TIMEOUT_MS`
- `MARKET_DATA_WS_PATH`

说明:

- 公共行情可用于本地联调和前端接入，Redis 快照与 ClickHouse 分析落盘都可通过环境变量切换（`MARKET_DATA_SNAPSHOT_STORE`、`MARKET_DATA_ANALYTICS_SINK`）
- 更完整的 analytics、查询窗口控制和多周期统计属于行情分析管线的延伸主题

延伸阅读:

- [08 行情](../../learning/08-market-data.md)
- [06 订单与撮合](../../learning/06-order-matching.md)
- [事件目录](../../docs/event-catalog.md)
