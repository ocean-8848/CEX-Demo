# Risk Service

职责:

- 作为现货下单前的风控与规则校验服务
- 判断订单是否满足市场规则和余额要求
- 给 `order-service` 返回需要冻结的资产和金额
- 市场监控：定时扫描成交与撤单，生成对敲、成交集中、幌骗、价格异动告警（只读，不拦截交易）

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
  - `limit`（可带 `postOnly`）
  - `market`
  - `stop_limit` / `stop_market`（必须带 `triggerPrice`）
- 时效:
  - `gtc`
  - `ioc`
  - `fok`
- 校验项:
  - 最小下单数量
  - 价格 step 对齐
  - 数量 step 对齐
  - 价格偏离参考价上限
  - Post-Only 只允许 GTC 限价单（`POST_ONLY_REQUIRES_GTC_LIMIT`）
  - `stpMode` 只能是 `expire_taker` / `expire_maker` / `expire_both`（`INVALID_STP_MODE`）
  - 止损单：`triggerPrice` 必填、为正、对齐价格 step，相对参考价不超过 `maxPriceDeviationRatio`（`TRIGGER_PRICE_DEVIATION_TOO_HIGH`）；止损限价的委托价相对触发价受同一上限约束；非止损单不允许带 `triggerPrice`
  - 账户可用余额
- 买单锁 `quote`，卖单锁 `base`；止损限价按委托价计算，止损市价买单按 `触发价 × 数量 × (1 + maxPriceDeviationRatio)` 计算

市场监控（`src/domain/surveillance.ts`、`src/application/surveillance-service.ts`）:

- 每 `RISK_SURVEILLANCE_INTERVAL_MS`（默认 60 秒，启动后约 10 秒首扫）从 `order-service` 的 `GET /api/v1/surveillance/activity` 读取最近 `RISK_SURVEILLANCE_LOOKBACK_MS`（默认 1 小时）的成交，以及“名义金额 ≥ 阈值、未成交、在 N 秒内撤销”的委托
- 检测器（阈值全部可用环境变量调整）:

| 类型 | 规则 | 默认阈值 | 证据 |
| --- | --- | --- | --- |
| `wash_trade` 对敲 / 自成交 | 同一用户同时是买方和卖方（同账户自成交已被撮合引擎 STP 阻止，这里兜底同一用户跨账户的成交；未用登录设备 / IP 做关联） | 1 小时内 ≥ 1 笔 | 自成交的成交 |
| `concentrated_volume` 成交集中 | 单一账户占市场“买卖双边参与度”的比例（自成交算两次） | > 30%，近 1 小时、市场成交额 ≥ 1000、≥ 5 笔 | 该账户的成交 |
| `spoofing` 幌骗 | 名义金额 ≥ 阈值的委托未成交即在 N 秒内撤单，反复出现 | ≥ 2000、30 秒内撤、10 分钟内 ≥ 3 笔 | 被撤的委托（含存活时长） |
| `price_move` 价格异动 | 窗口内最高价与最低价之差 / 最低价（市场级） | 5 分钟内 > 3% | 首笔、最高、最低、末笔成交 |

- 做市商：`config/fee-tiers.json` 的 `marketMakers`（演示的两个做市账户）默认不参与告警，撤单也不拉取；它们的成交仍计入市场总量，并在总览和证据里标注「做市商」。`RISK_SURVEILLANCE_INCLUDE_MARKET_MAKERS=true` 时以低级别告警
- 去重：`alert_key` = 检测器 + 市场 + 用户 + 窗口锚点；仍为 `open` 的告警在后续扫描中刷新证据；已确认 / 已忽略的告警保持结论，只有出现之前没被任何告警覆盖的成交 / 委托才新建告警
- 处理：`open → acknowledged / dismissed`、`acknowledged → dismissed / open`、`dismissed → open`，每次必须带备注并写入 `risk_surveillance_alert_events`

当前限制:

- 不包含用户 / IP 限频和限额计数器（入口限流在 `api-gateway`）
- 市场监控是分钟级批量扫描，不是流式；没有关联账户图（设备、IP、资金往来）

运行脚本:

- `pnpm --filter @web3-cex/risk-service db:prepare`（建 `risk_market_status_overrides`、市场监控 `risk_surveillance_alerts` / `risk_surveillance_alert_events` 与紧急开关 `risk_control_switches` / `risk_control_switch_events` 表，基线为 [sql/001_schema.sql](sql/001_schema.sql)，只执行尚未记录在 `schema_migrations` 的文件；已包含在根目录 `pnpm db:prepare:core`）
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
- `ORDER_SERVICE_BASE_URL`（市场监控数据源，默认 `http://127.0.0.1:3009`）
- `RISK_SURVEILLANCE_ENABLED`（默认开启，`false` 关闭定时扫描）、`RISK_SURVEILLANCE_INTERVAL_MS`（默认 `60000`）、`RISK_SURVEILLANCE_STORE`（`memory` 时告警存内存）
- `RISK_SURVEILLANCE_LOOKBACK_MS`、`RISK_SURVEILLANCE_WASH_MIN_TRADES`、`RISK_SURVEILLANCE_WASH_WINDOW_MS`
- `RISK_SURVEILLANCE_CONCENTRATION_RATIO`、`RISK_SURVEILLANCE_CONCENTRATION_WINDOW_MS`、`RISK_SURVEILLANCE_CONCENTRATION_MIN_VOLUME`、`RISK_SURVEILLANCE_CONCENTRATION_MIN_TRADES`
- `RISK_SURVEILLANCE_SPOOF_MIN_NOTIONAL`、`RISK_SURVEILLANCE_SPOOF_MAX_LIFETIME_MS`、`RISK_SURVEILLANCE_SPOOF_MIN_ORDERS`、`RISK_SURVEILLANCE_SPOOF_WINDOW_MS`
- `RISK_SURVEILLANCE_PRICE_MOVE_RATIO`、`RISK_SURVEILLANCE_PRICE_MOVE_WINDOW_MS`、`RISK_SURVEILLANCE_INCLUDE_MARKET_MAKERS`

HTTP 接口:

- `POST /api/v1/risk/orders/validate`
- `GET /api/v1/risk/markets`、`GET /api/v1/risk/markets/:market`：配置状态 + 运行时覆盖 + 生效状态
- `POST /api/v1/risk/markets/:market/status`：`{ status: "halted" | "listed", reason, operator }`，暂停必须填原因；设回配置默认值时删除覆盖行
- `GET /api/v1/risk/surveillance/overview`、`POST /api/v1/risk/surveillance/scan`
- `GET /api/v1/risk/surveillance/alerts`（`type`、`status`、`market`、`userId`、`includeMarketMakers`、分页）、`GET /api/v1/risk/surveillance/alerts/:alertId`
- `POST /api/v1/risk/surveillance/alerts/:alertId/status`：`{ status, note, actor }`
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
- [B05 业务风控](../../learning/backstage/B05-business-risk.md)（市场监控）
- [市场配置](../../config/README.md)
