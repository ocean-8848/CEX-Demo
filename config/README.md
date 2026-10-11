# 市场与币种配置（`config/markets.json`）

`markets.json` 是全系统唯一的市场 / 币种定义来源。`packages/domain` 在进程启动时读取并校验它，
所有服务、BFF 和演示脚本都从 domain 的导出派生自己的列表，代码里没有硬编码的市场清单
（`pnpm check:markets` 会做动态 + 静态双重检查）。

## 结构

```jsonc
{
  "version": 1,
  "defaultMarket": "ETH-USDT",          // trader-web 默认市场、demo 脚本主市场；不能是 delisted
  "assets": [
    {
      "code": "SOL",                    // ^[A-Z][A-Z0-9]{1,9}$
      "name": "Solana",
      "decimals": 9,                    // 资产精度；数量步长 / 价格步长的小数位不能超过它
      "displayDecimals": 3,
      "networks": ["ethereum"],         // 只能从代码支持的网络中选：ethereum / bsc / base / solana / bitcoin
      "withdrawalFee": "0.01",          // trader-web 提现时展示并提交的固定手续费
      "demo": {                         // 可选：只影响演示环境
        "faucetMaxAmount": "200",       // 水龙头单次上限（缺省 = 该币不支持水龙头）
        "faucetPresets": ["10", "50"],  // 前台快捷金额
        "depositSourceFloor": "10000"   // 钱包入金国库的保底余额（bootstrap / 模拟器补足）
      }
    }
  ],
  "markets": [
    {
      "symbol": "SOL-USDT",             // 必须等于 <baseAsset>-<quoteAsset>
      "baseAsset": "SOL",
      "quoteAsset": "USDT",
      "status": "listed",               // listed | halted | delisted（默认状态，运营可在运行时暂停 / 恢复）
      "priceStep": "0.01",
      "quantityStep": "0.01",
      "minQuantity": "0.01",            // 必须对齐 quantityStep
      "makerFeeRate": "0.0005",
      "takerFeeRate": "0.001",
      "maxPriceDeviationRatio": "0.2",  // 风控价格偏离上限
      "referencePrice": "150",          // 风控兜底参考价 + 模拟器初始中间价
      "simulator": {                    // 可选：demo-simulator 做市参数
        "enabled": true,
        "midPrice": "150",              // 可选，缺省取 referencePrice
        "minQuantity": "0.5",
        "maxQuantity": "40",
        "baseInventory": "1500",        // 卖方做市账户保有的 base 库存
        "quoteInventory": "250000"      // 买方做市账户保有的 quote 库存
      }
    }
  ]
}
```

- 结构约束见 [markets.schema.json](markets.schema.json)（编辑器补全用）。
- 交叉约束（引用的币种存在、symbol 与币种一致、步长对齐、费率 < 1、精度、重复项、未知字段）由
  `packages/domain/src/market-config.ts` 的 `parseMarketConfig()` 校验，**任何一项不合法服务都会拒绝启动**并列出全部问题。
- 换一份配置：设置 `WEB3_CEX_MARKETS_CONFIG=/path/to/markets.json`（所有服务和脚本都读同一个变量）。
- 单个市场的兜底参考价可用 `RISK_REFERENCE_PRICE_<BASE>_<QUOTE>` 覆盖（risk-service 与模拟器共用）；
  水龙头上限可用 `DEMO_FAUCET_MAX_<ASSET>` 覆盖。

## 上线一个新市场（不改代码）

1. 如果是新币种，在 `assets` 加一项（`networks` 填 `["ethereum"]` 即可走本地模拟 EVM 链，充提与 SOL 完全一致）。
2. 在 `markets` 加一项，`status: "listed"`，按需打开 `simulator.enabled`。
3. `pnpm check:markets` 校验，然后重启全栈（`pnpm stack:stop && pnpm demo:up`）。
4. 自动生效的部分：risk 校验规则 / 参考价、order-service 引擎同步与事件流、撮合引擎（按 symbol 自动建簿）、
   settlement 结算与手续费账户（`platform:spot:fee:<asset>` 首次成交时自动创建）、market-data ticker / depth / K 线、
   gateway 持仓快照、trader-web 市场列表 / 资产页 / 水龙头、ops-console 下拉框与「市场管理」页、
   demo-simulator 做市与水龙头、demo reset 清簿、wallet 充提币种校验。

## 状态：listed / halted / delisted

| 状态 | 新委托 | 撤单 | 前台可见 | 运行时可改 |
| --- | --- | --- | --- | --- |
| `listed` | 允许 | 允许 | 是 | 可暂停 |
| `halted` | risk 拒绝 `MARKET_HALTED`（409） | 允许 | 是 | 可恢复 |
| `delisted` | risk 拒绝 `MARKET_DELISTED`（409） | 允许 | 否 | 否（只能改文件） |

运营在 ops-console「市场管理」页暂停 / 恢复市场：覆盖值存在 risk-service 的 `risk_market_status_overrides` 表里，
文件里的 `status` 是默认值；恢复到默认状态时覆盖行被删除。`pnpm demo:reset` 会清空覆盖。

## 延伸阅读

- [11 产品生态及其背后实现](../learning/11-products-ecosystem.md)、[P07 上币与新币发行](../learning/products/P07-listing-launch.md)
- [领域模型](../docs/domain-model.md)
