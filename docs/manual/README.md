# CEX Demo 使用手册

这份手册按页面介绍 CEX Demo 的全部功能：用户侧的交易前台 `trader-web`，以及运营侧的运营后台 `ops-console`。每个功能都配有截图、操作步骤，并说明背后经过了哪些服务。

截图来自 `pnpm demo:up` 启动后的本地演示环境，所有资产均为测试数据。

## 目录

| 篇章 | 内容 |
|---|---|
| [01 启动与登录](01-getting-started.md) | 一键启动、入口地址、演示账户、前后台登录 |
| **交易前台 trader-web** | |
| [02 首页与学习模式](02-trader-home-and-learning.md) | 首页、学习模式、撮合回放、场景导览、通知中心 |
| [03 交易与订单](03-trader-trading.md) | 交易页、订单簿、下单（限价 / 市价 / 止损、只做 Maker、自成交保护）、订单中心、成交 T 型账户 |
| [04 资产：充值、提现与流水](04-trader-assets.md) | 资产总览、充值与测试水龙头、提现、资金流水 / 对账单、储备金证明 |
| [05 账户与安全](05-trader-account.md) | 会话、两步验证、KYC 与限额、手续费等级（VIP）、设备管理与登录记录、API Key |
| **运营后台 ops-console** | |
| [06 总览、业务追踪与审计](06-ops-overview-and-trace.md) | 后台布局、运营总览（P1 / P2 / P3 告警）、业务追踪、操作审计 |
| [07 资金运营](07-ops-funds.md) | 提现审核（地址风险评分）与双人复核、充值与链上、用户与资产、KYC 审核、地址黑名单 |
| [08 交易、市场与账本](08-ops-trading-and-ledger.md) | 交易与结算、市场管理、账本对账（定时对账与熔断）、钱包与储备金、市场监控 |
| [09 系统运维与故障实验室](09-ops-system-and-lab.md) | 分级告警、托管、恢复、事件总线、自动化、故障注入、紧急开关 |
| **串起来** | |
| [10 端到端场景](10-scenarios.md) | 第一笔交易、充值到账、提现审核、大额双人复核、排查结算异常 |

## 怎么读

- **第一次用**：按 01 → 02 → 03 → 04 的顺序，在前台完成一笔交易和一次充值；再看 07，在后台批准一笔提现。
- **想理解系统**：打开前台的「学习模式」后再操作，并对照每节末尾的「背后的服务」和「延伸学习」。
- **想看完整链路**：直接读 [10 端到端场景](10-scenarios.md)。

更多文档：[安装与运行](../getting-started.md) · [演示导览](../demo-walkthrough.md) · [系统架构](../architecture.md) · [交易所学习材料](../../learning/README.md)

## 重新生成截图

界面改动后，可以在已启动并播种的全栈上重新截图（需要本机 Chrome）：

```bash
pnpm docs:screenshots
```

脚本是 [scripts/capture-manual-screenshots.mjs](../../scripts/capture-manual-screenshots.mjs)，截图输出到 `docs/manual/images/`。截图过程中会真实执行一些演示操作：下单、水龙头充值、提交并批准一笔提现、提交 KYC 申请。传入名称过滤时只保存匹配的截图（演示操作仍会执行），例如 `pnpm docs:screenshots ops-system`。
