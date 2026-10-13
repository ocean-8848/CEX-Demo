# Risk Service

职责:

- 作为现货下单前的风控与规则校验服务
- 判断订单是否满足市场规则和余额要求
- 给 `order-service` 返回需要冻结的资产和金额

主链定位:

- 职责是把“订单能不能进撮合”这件事独立成前置校验层
- 学习时优先看市场规则、余额校验和锁定资产计算
- 如果目标是解释为什么风控不能直接写在下单接口里，这个服务就是规则边界

当前实现:

- HTTP 服务，默认端口 `3008`
- 支持的市场与规则（步长、最小数量、费率、价格偏离上限、兜底参考价、默认状态）全部来自 [config/markets.json](../../config/markets.json)，默认为 `BTC-USDT`、`ETH-USDT`、`SOL-USDT`
- 紧急开关（运营紧急开关的所属服务，`src/application/control-switch-service.ts`）：全站提现暂停 `withdrawals_global`、单币种提现暂停 `withdrawals_asset`、API 写入冻结 `api_write`。开启必须带原因；`source: "automatic"`（ledger-service 对账熔断）不覆盖已开启的开关、不能关闭开关；每次变更写 `risk_control_switch_events`。wallet-service 与 api-gateway 读取后执行，本服务的下单校验在 API 写入冻结时返回 `409 API_WRITE_FROZEN`
- 市场状态：`halted` 拒绝新委托（`409 MARKET_HALTED`，含暂停原因），`delisted` 拒绝新委托（`409 MARKET_DELISTED`）；撤单不经过风控，始终允许
- 订单类型:
  - `limit`
  - `market`
- 时效:
  - `gtc`
  - `ioc`
  - `fok`
- 校验项:
  - 最小下单数量
  - 价格 step 对齐
  - 数量 step 对齐
  - 价格偏离参考价上限
  - 账户可用余额
- 买单锁 `quote`，卖单锁 `base`

当前限制:

- 不包含用户 / IP 限频和限额计数器（入口限流在 `api-gateway`）

运行脚本:

- `pnpm --filter @web3-cex/risk-service db:prepare`（建 `risk_market_status_overrides` 表与紧急开关的 `risk_control_switches` / `risk_control_switch_events` 表，见 [sql/001_market_status_overrides.sql](sql/001_market_status_overrides.sql)、[sql/002_control_switches.sql](sql/002_control_switches.sql)；已包含在根目录 `pnpm db:prepare:core`）
- `pnpm --filter @web3-cex/risk-service build`
- `pnpm --filter @web3-cex/risk-service start`
- `pnpm --filter @web3-cex/risk-service test`
- `pnpm --filter @web3-cex/risk-service typecheck`

环境示例:

- [.env.example](.env.example)

关键环境变量:

- `PORT`
- `LEDGER_SERVICE_BASE_URL`
- `RISK_MARKET_DATA_URL`（实时参考价来源，默认 market-data-service）
- `RISK_REFERENCE_PRICE_MODE`（设为 `configured` 时只用配置值）
- `RISK_REFERENCE_PRICE_<BASE>_<QUOTE>`（可选，覆盖配置中的 `referencePrice`，如 `RISK_REFERENCE_PRICE_SOL_USDT`）
- `RISK_MARKET_STATUS_STORE`（`postgres` 默认 / `memory`，紧急开关使用同一模式）、`RISK_MARKET_STATUS_CACHE_MS`（默认 `1000`）、`RISK_CONTROL_SWITCH_CACHE_MS`（默认 `1000`）、`DATABASE_URL` / `PG*`

HTTP 接口:

- `POST /api/v1/risk/orders/validate`
- `GET /api/v1/risk/markets`、`GET /api/v1/risk/markets/:market`：配置状态 + 运行时覆盖 + 生效状态
- `POST /api/v1/risk/markets/:market/status`：`{ status: "halted" | "listed", reason, operator }`，暂停必须填原因；设回配置默认值时删除覆盖行
- `GET /api/v1/risk/controls`：紧急开关状态（调用方 wallet-service、api-gateway、ops-console）
- `POST /api/v1/risk/controls`：`{ scope, assetCode?, enabled, reason, operator, source? }`，返回 `{ changed, entry, state }`（调用方 ops-console、ledger-service）
- `GET /api/v1/risk/controls/events?limit=`：开关变更记录

返回重点:

- `valid`
- `lockAssetCode`
- `lockAmount`
- `checks`

说明:

- `order-service` 在下单前强依赖 `risk-service`
- 限频、限额和更重的交易前风控编排属于延伸主题

参考价:

价格偏离保护与市价买单冻结额都以「参考价」为基准，按以下顺序取值：

1. 请求显式传入的 `referencePrice`
2. market-data-service 的最新成交价（`last_trade`）
3. 盘口中间价（`mid_price`）
4. 配置值：`RISK_REFERENCE_PRICE_<BASE>_<QUOTE>`，否则 `config/markets.json` 的 `referencePrice`（`configured`）

实时价格缓存 1 秒；行情服务不可用时自动回退到配置值，不阻塞交易。设置 `RISK_REFERENCE_PRICE_MODE=configured` 可只用配置值。风控结果中的 `referencePrice` / `referencePriceSource` 以及拒单信息会注明参考价来源。

延伸阅读:

- [09 风控](../../learning/09-risk-control.md)
- [B08 实时风控平台](../../learning/backstage/B08-risk-platform.md)
- [市场配置](../../config/README.md)
