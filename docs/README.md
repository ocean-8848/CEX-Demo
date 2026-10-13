# 文档索引

这里是 CEX Demo 的使用与设计文档。交易所通用知识（不限于本仓库）见 [../learning/README.md](../learning/README.md)。

## 上手

| 文档 | 内容 |
|---|---|
| [getting-started.md](getting-started.md) | 环境要求、安装、一键启动、端口、演示账户、脚本与测试 |
| [demo-walkthrough.md](demo-walkthrough.md) | 交易前台与运营后台导览，充值 / 交易 / 提现等端到端演示场景 |
| [troubleshooting.md](troubleshooting.md) | 常见问题与排查 |
| [manual/](manual/README.md) | **使用手册**：按页面介绍前台与后台全部功能，含截图 |

## 设计

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 技术栈、服务分层、调用关系、三条主链时序图、冷热分层与储备金证明、与真实交易所的差异 |
| [domain-model.md](domain-model.md) | 核心实体、状态机与不变量 |
| [ledger-service-design.md](ledger-service-design.md) | 双分录账本、冻结生命周期、并发控制、对账与回放 |
| [event-catalog.md](event-catalog.md) | 服务间事件、生产者 / 消费者与投递语义 |
| [api-contracts.md](api-contracts.md) | 对外 API、WebSocket、运营 BFF 与内部服务接口 |
| [security.md](security.md) | 已实现的安全控制、威胁模型、走向真实环境还缺什么 |
| [fault-lab.md](fault-lab.md) | 故障注入实验室：注入、观察与恢复 |

## 模块文档

- 前端：[trader-web](../apps/trader-web/README.md) · [ops-console](../apps/ops-console/README.md)
- 接入：[api-gateway](../services/api-gateway/README.md)
- 交易：[risk-service](../services/risk-service/README.md) · [order-service](../services/order-service/README.md) · [matching-engine](../engines/matching-engine) · [settlement-service](../services/settlement-service/README.md) · [market-data-service](../services/market-data-service/README.md)
- 资金：[identity-service](../services/identity-service/README.md) · [wallet-service](../services/wallet-service/README.md) · [blockchain-indexer](../services/blockchain-indexer/README.md) · [custody-adapter](../services/custody-adapter/README.md) · [ledger-service](../services/ledger-service/README.md)
- 配置与基础设施：[config/markets.json 与 fee-tiers.json](../config/README.md) · [infra/local](../infra/local/README.md)

## 推荐阅读顺序

1. [getting-started.md](getting-started.md)：先跑起来。
2. [demo-walkthrough.md](demo-walkthrough.md)：打开学习模式走一遍主链。
3. [architecture.md](architecture.md)：建立全局视图，再按兴趣读账本、事件、接口。
4. 对照 [../learning/](../learning/README.md) 的相应章节理解真实交易所的做法。
