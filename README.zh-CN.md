# CEX Demo

[English](README.md) | **简体中文**

一个可以完整运行的**中心化加密货币交易所（CEX）演示系统**，加上一套讲解真实交易所如何运作的**系统学习材料**。本项目用于学习：所有资产都是测试数据，链是本地模拟的 EVM 链。

仓库分为两部分：

| 部分 | 内容 | 入口 |
|---|---|---|
| **CEX Demo** | 现货交易所 monorepo：交易前台、运营后台、API 网关、10 个后端服务、Rust 撮合引擎、做市与链模拟器。 | [快速开始](#快速开始) · [docs/](docs/README.md) |
| **学习材料** | 13 章主线、12 篇幕后核心、11 篇产品深潜、22 个交互实验、40 集动画讲解幻灯片。 | [learning/](learning/README.md) |

## Demo 覆盖的能力

- **现货交易**：`ETH/USDT`（默认）、`BTC/USDT`、`SOL/USDT`；限价 / 市价 / 止损限价 / 止损市价，GTC / IOC / FOK，只做 Maker、自成交保护，订单簿、成交、K 线；按 30 日成交量分级的 VIP Maker / Taker 手续费（`config/fee-tiers.json`）。
- **资金**：充值地址、带确认数进度的测试水龙头、带审核的提现，以及支持冻结 / 解冻 / 最终消耗的双分录账本；冷热钱包分层（归集、按水位提出并经运营审批的冷热调拨）、钱包 vs 账本对账，以及用户可在浏览器里自行验证 Merkle 叶子的储备金证明。
- **账户与安全**：HttpOnly Cookie 会话、自助 2FA、KYC 等级与提现限额、API Key（keyId + secret 签名）、RBAC、服务间签名调用。
- **运营**：提现审核（大额双人复核）、KYC 审核、手续费等级指定、市场暂停 / 恢复、市场监控告警（对敲、幌骗、成交集中、价格异动）、账本对账、按任意业务 ID 追踪、操作审计、故障注入实验室。
- **学习模式**（交易前台）：实时显示每个操作经过的服务，逐步回放撮合过程，可跳转 Jaeger 查看调用链。

## 架构概览

```
trader-web ─┐                          ┌─ risk-service
ops-console ┼─ api-gateway / BFF ──────┼─ order-service ── matching-engine (Rust)
            │                          ├─ settlement-service
            │                          ├─ market-data-service
            │                          ├─ identity-service
            │                          ├─ wallet-service ── blockchain-indexer
            │                          ├─ custody-adapter
            │                          └─ ledger-service（双分录账本，资金事实源）
demo-simulator：做市商 + 模拟 EVM 链 + 测试水龙头
基础设施：PostgreSQL · Redis · Kafka · ClickHouse（Docker）
```

技术栈：TypeScript + NestJS 服务、Rust 撮合引擎、React 单页应用、PostgreSQL、Redis、Kafka、ClickHouse，可选 OpenTelemetry + Jaeger。详见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

前置条件：Node.js 22（版本见 [.nvmrc](.nvmrc)，可用 `nvm use`）、pnpm 10、Rust（stable）、Docker。只有浏览器 E2E 测试需要 Chrome。

```bash
pnpm install --frozen-lockfile
pnpm demo:up
```

`demo:up` 会启动 Docker 基础设施，构建并启动全部服务（含模拟器），然后初始化演示数据。完成后打开：

| 应用 | 地址 | 登录 |
|---|---|---|
| 交易前台 | <http://127.0.0.1:3013> | 点「一键登录演示账户」，或注册新账户后在「资产」页的测试水龙头领取测试币 |
| 运营后台 | <http://127.0.0.1:3006> | `ops-admin@example.com` / `OpsAdminPass123!`，动态码用 `pnpm -s ops:totp` 获取 |
| 复核人（第二审批人） | <http://127.0.0.1:3006> | `ops-reviewer@example.com` / `OpsReviewerPass123!`，动态码用 `pnpm -s ops:totp reviewer` |

以上账户和 TOTP 种子只是本地演示数据。

停止：`pnpm stack:stop`（连同 Docker：`pnpm stack:stop:infra`）。

接下来：

- [docs/getting-started.md](docs/getting-started.md)：端口、环境变量、脚本与测试
- [docs/manual/](docs/manual/README.md)：使用手册，按页面介绍前后台全部功能，含截图
- [docs/demo-walkthrough.md](docs/demo-walkthrough.md)：前后台导览与主要资金链路演示
- [docs/troubleshooting.md](docs/troubleshooting.md)：常见问题

## 目录结构

```
apps/          trader-web（用户前台）、ops-console（运营后台 + BFF）
services/      api-gateway、identity、wallet、blockchain-indexer、custody-adapter、
               ledger、risk、order、settlement、market-data
engines/       matching-engine（Rust）
packages/      domain（共享类型与市场配置）、web-ui、telemetry
config/        markets.json：市场与币种的唯一来源
infra/local/   PostgreSQL / Redis / Kafka / ClickHouse / Jaeger 的 docker-compose
scripts/       全栈启停、演示数据、模拟器、验证与 E2E
docs/          Demo 文档（安装、演示、架构、接口、安全）
learning/      交易所学习材料（章节、交互实验、幻灯片）
```

## 测试

```bash
pnpm build && pnpm typecheck
pnpm -r --if-present test
cargo test --manifest-path engines/matching-engine/Cargo.toml
pnpm test:e2e        # 需要先 pnpm demo:up 启动并播种全栈
```

## 学习路线

1. 先读 [learning/01-what-is-cex.md](learning/01-what-is-cex.md) 和 [learning/02-system-architecture.md](learning/02-system-architecture.md)。
2. 启动 Demo，打开学习模式，按 [docs/demo-walkthrough.md](docs/demo-walkthrough.md) 走一遍。
3. 按模块深入：账本（[第 05 章](learning/05-ledger.md)）、撮合（[06](learning/06-order-matching.md)）、清结算（[07](learning/07-clearing-settlement-fees.md)）等。每章末尾的「本仓库对照」一节把概念对应到本仓库代码。
4. 动手做 [learning/interactive/](learning/interactive/index.html) 里的交互实验，看 [learning/slides/](learning/slides/index.html) 里的幻灯片。两者都可以直接用浏览器打开，不需要服务器。

## 用途

本项目用于学习交易所系统设计。它是运行在模拟链上的单机简化演示，不面向生产环境，也不用于真实资金。

## 许可证

[MIT](LICENSE)
