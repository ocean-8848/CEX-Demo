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

## 手续费等级（`config/fee-tiers.json`）

VIP 手续费等级的唯一来源，`packages/domain/src/fee-tiers.ts` 的 `parseFeeTierConfig()` 在进程启动时校验（结构见
[fee-tiers.schema.json](fee-tiers.schema.json)，换文件用 `WEB3_CEX_FEE_TIERS_CONFIG`）。

```jsonc
{
  "version": 1,
  "volumeAsset": "USDT",              // 成交量口径：只统计报价资产为 USDT 的市场；必须是 markets.json 里的资产
  "volumeWindowDays": 30,             // 滚动窗口（天）
  "tiers": [                          // minVolume 严格递增，第一档必须是 0；费率逐档不升
    { "tier": "VIP0", "name": "普通用户", "minVolume": "0",      "makerFeeRate": "0.0005", "takerFeeRate": "0.001" },
    { "tier": "VIP1", "name": "VIP 1", "minVolume": "100000", "makerFeeRate": "0.0004", "takerFeeRate": "0.0009" }
  ],
  "marketMakers": [                   // 做市商计划：标注为「做市商」，可固定等级
    { "userId": "10000000-0000-0000-0000-000000000301", "label": "做市商 Ask", "feeTier": "VIP0" }
  ]
}
```

- 当前阶梯：VIP0 ≥ 0（0.05% / 0.1%，等于各市场默认费率）、VIP1 ≥ 100,000 USDT（0.04% / 0.09%）、VIP2 ≥ 500,000（0.03% / 0.08%）、
  VIP3 ≥ 2,000,000（0.02% / 0.06%）。
- 解析顺序：ops-console 运营指定（`spot_fee_tier_overrides`）> `marketMakers[].feeTier` > 30 日成交量。
- 实际费率 = `min(等级费率, 市场费率)`，所以市场可以单独设更低的促销费率；VIP0 与市场默认相同，等级功能不会改变普通用户的手续费。
- 演示的两个做市账户固定在 VIP0：它们每小时有数十万 USDT 的成交，不固定的话很快升到 VIP3，演示里的手续费数字会随时间变化。
  `marketMakers` 也是 risk-service 市场监控的做市商名单（只标注、默认不告警）。
- `pnpm check:markets` 会额外校验 VIP0 与每个市场的默认费率一致；`ORDER_FEE_TIERS_ENABLED=false` 可让 order-service 退回市场默认费率。

## 延伸阅读

- [11 产品生态及其背后实现](../learning/11-products-ecosystem.md)、[P07 上币与新币发行](../learning/products/P07-listing-launch.md)
- [领域模型](../docs/domain-model.md)
- [07 清算结算与手续费](../learning/07-clearing-settlement-fees.md)、[12 商业模式](../learning/12-business-model.md)
