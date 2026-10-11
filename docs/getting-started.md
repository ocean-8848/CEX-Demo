# 快速开始

本文说明如何在本机把整套 Web3 CEX 学习 demo 跑起来、登录前后台、单独启动某个服务，以及如何运行各类测试。遇到问题时请看 [troubleshooting.md](./troubleshooting.md)。

## 1. 前置条件

| 工具 | 版本要求 | 用途 |
| --- | --- | --- |
| Node.js | 22（版本见根目录 `.nvmrc`，与 CI 一致） | 运行全部 TypeScript 服务、前端 Web Host 和脚本 |
| pnpm | 10（`package.json` 中 `packageManager` 锁定为 `pnpm@10.6.0`，可用 `corepack enable` 自动匹配） | monorepo 依赖管理与脚本入口 |
| Rust | stable 工具链（含 `cargo`） | 编译并运行 `engines/matching-engine` |
| Docker | 支持 `docker compose`（Compose v2） | 本地 PostgreSQL / Redis / Kafka / ClickHouse（可选 Jaeger） |
| Google Chrome | 任意较新版本，仅浏览器 E2E 需要 | `trader-web` / `ops-console` 浏览器测试（通过 `playwright-core` 驱动本机 Chrome，不会自动下载浏览器） |

## 2. 安装依赖

```bash
pnpm install --frozen-lockfile
```

依赖版本由仓库中的 `pnpm-lock.yaml` 锁定，使用 `--frozen-lockfile` 可以保证与 CI 安装结果一致。

## 3. 一键启动

```bash
pnpm demo:up
```

`demo:up` 等价于 `pnpm stack:start && pnpm demo:prepare`，依次完成:

1. 检查服务端口是否已被占用（发现占用会直接退出，提示先执行 `pnpm stack:stop`）。
2. `docker compose -f infra/local/docker-compose.yml up -d` 启动基础设施。
3. `pnpm build` 构建整个 workspace。
4. `pnpm db:prepare:demo` 初始化所有服务的数据库表结构。
5. 按固定顺序在后台启动全部服务，每个服务等待端口就绪（撮合引擎最多等 45 秒，其余 30 秒）；任何一个失败都会自动停掉已启动的服务。
6. `pnpm demo:reset` 清空 PostgreSQL / Redis / ClickHouse 和撮合引擎订单簿中的演示数据。
7. `pnpm demo:bootstrap` 写入固定的种子用户、初始资产、充值地址、提币白名单和簿内流动性，并恢复做市商报价。

服务的运行时文件位于 `.runtime/full-stack/`（已被 `.gitignore` 忽略）:

- `logs/<service>.log`: 每个服务的标准输出与错误输出
- `pids/<service>.pid`: 托管进程的 PID
- `state.json`: 本次启动的服务清单

查看状态:

```bash
pnpm stack:status
```

每个服务会显示 `running`、`starting`、`stopped` 或 `port-in-use`（端口被非托管进程占用）。

`stack:start` 还接受以下参数（可以组合使用，例如 `pnpm stack:start --skip-build`）:

| 参数 | 作用 |
| --- | --- |
| `--skip-infra` | 不执行 `docker compose up -d` |
| `--skip-build` | 不执行 `pnpm build`（已经构建过时可加快启动） |
| `--skip-db-prepare` | 不执行 `pnpm db:prepare:demo` |
| `--observability` | 同时启动 Jaeger 并为各 Node 服务开启 OpenTelemetry 导出（即 `pnpm stack:start:observability`） |

## 4. 服务与端口

### 4.1 应用服务

`stack:start` 按下表顺序启动（来源: `scripts/full-stack-lib.mjs`）:

| 服务 | 端口 | 启动方式 | 说明 |
| --- | --- | --- | --- |
| `matching-engine` | `3011` | `cargo run` | Rust TCP 撮合引擎 |
| `identity-service` | `3005` | `node dist/main.js` | 用户、会话、2FA、RBAC、API Key、KYC（仅监听 `127.0.0.1`，需内部签名） |
| `ledger-service` | `3001` | `node dist/main.js` | 双分录账本、余额、冻结 / 解冻 / 消耗（仅监听 `127.0.0.1`，需内部签名） |
| `ledger-outbox-publisher` | - | `node dist/scripts/publish-outbox.js` | 常驻 worker，把账本 outbox 事件发布到 Kafka |
| `wallet-service` | `3002` | `node dist/main.js` | 充值地址、充值单、提币申请与审核、通知（仅监听 `127.0.0.1`，需内部签名） |
| `blockchain-indexer` | `3003` | `node dist/main.js` | 链上观测、确认数推进、提币确认 |
| `custody-adapter` | `3004` | `node dist/main.js` | 托管 provider 路由、广播、状态回查 |
| `risk-service` | `3008` | `node dist/main.js` | 下单前风控、市场暂停（仅监听 `127.0.0.1`，需内部签名） |
| `settlement-service` | `3010` | `node dist/main.js` | 成交结算与入账（仅监听 `127.0.0.1`，需内部签名） |
| `order-service` | `3009` | `node dist/main.js` | 订单生命周期、预冻结、撮合桥接（仅监听 `127.0.0.1`，需内部签名） |
| `market-data-service` | `3012` | `node dist/main.js` | ticker / depth / trades / K 线、公共 WebSocket |
| `api-gateway` | `3007` | `node dist/main.js` | 客户侧 REST、私有 WebSocket、鉴权、限流、幂等 |
| `demo-simulator` | `3014` | `node scripts/demo-simulator.mjs` | 仅演示环境: 做市商、1.5 秒出块的模拟 EVM 链、测试水龙头、故障实验室链侧开关 |
| `ops-console` | `3006` | `node dist/main.js` | 运营后台（React 前端 + NestJS BFF） |
| `trader-web` | `3013` | `node dist/main.js` | 交易前台（React SPA + 同源代理的 Web Host） |

Node 服务都以 `node --import @web3-cex/telemetry/register ./dist/main.js` 启动；未开启追踪时该预加载是空操作。

### 4.2 基础设施（`infra/local/docker-compose.yml`）

| 组件 | 容器名 | 端口 | 说明 |
| --- | --- | --- | --- |
| PostgreSQL 16 | `web3-cex-postgres` | `5432` | 库 `web3_cex`，账号 `web3 / web3` |
| Redis 7 | `web3-cex-redis` | `6379` | 限流、幂等、交易事件 Stream、行情快照 |
| Kafka 4.0.1 | `web3-cex-kafka` | `9092` | 账本 outbox 事件 |
| ClickHouse 24.8 | `web3-cex-clickhouse` | `8123`（HTTP）、`9000`（Native） | 行情快照与 K 线 |
| Jaeger 1.62.0（可选） | `web3-cex-jaeger` | `16686`（UI）、`4318`（OTLP HTTP） | 仅在 `observability` profile 下启动 |

更多说明见 [infra/local/README.md](../infra/local/README.md)。

## 5. 入口与演示账户

| 入口 | 地址 | 登录方式 |
| --- | --- | --- |
| 交易前台 `trader-web` | <http://127.0.0.1:3013> | 登录页点击「一键登录演示账户」，或注册新账户后在「资产 → 测试水龙头」领取测试币 |
| 运营后台 `ops-console` | <http://127.0.0.1:3006> | 见下方运营账户 |
| Jaeger UI（可选） | <http://127.0.0.1:16686> | 无需登录，仅在开启追踪时可用 |

种子账户（来源: `scripts/mvp-demo-lib.mjs`）:

| 角色 | 邮箱 | 密码 | 2FA |
| --- | --- | --- | --- |
| 演示交易用户 | `demo-trader@example.com` | `DemoTraderPass123!` | 默认未开启，可在前台「账户」页自助开启 |
| 运营管理员（`ops_admin`） | `ops-admin@example.com` | `OpsAdminPass123!` | TOTP，`pnpm -s ops:totp` |
| 运营复核人（`ops_reviewer`） | `ops-reviewer@example.com` | `OpsReviewerPass123!` | TOTP，`pnpm -s ops:totp reviewer` |

获取运营 TOTP 动态码:

```bash
pnpm -s ops:totp            # ops-admin@example.com
pnpm -s ops:totp reviewer   # ops-reviewer@example.com
```

输出形如 `123456  (valid for 17s, account ops-admin@example.com)`。种子 TOTP 密钥是公开的演示值（`JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` / `KRUGKIDROVUWG2ZAMJZG653OEBTG66BA`），也可以导入任意验证器 App；设置 `OPS_TOTP_SECRET` 可让脚本改用其他密钥。同一个动态码在同一用户上只能使用一次，重复使用需要等下一个 30 秒窗口。

几个常用的演示行为:

- 在运营后台「提现审核」批准提现后，`demo-simulator` 的模拟链约 20 秒（12 个确认 × 1.5 秒出块）完成确认。
- 超过大额阈值（默认 `5000 USDT / 2 ETH / 0.1 BTC`，见 `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_BY_ASSET`）的提现需要管理员和复核人两人先后批准。
- 前台右上角可以打开「学习模式」，下单或充值时会列出请求依次经过的服务。
- 完整的前后台演示路线见 [demo-walkthrough.md](./demo-walkthrough.md)，故障注入实验见 [fault-lab.md](./fault-lab.md)。

## 6. 可观测性（可选）

```bash
pnpm stack:start:observability
```

与 `pnpm stack:start` 相比，它额外:

1. 以 `--profile observability` 启动 `web3-cex-jaeger`。
2. 为每个 Node 服务注入 `OTEL_ENABLED=true`、`OTEL_SERVICE_NAME=<服务 id>`、`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`（可用同名环境变量覆盖导出地址）。

启动后打开 <http://127.0.0.1:16686> 查看调用链。`api-gateway` 的响应会带 `x-trace-id` 头，可在 Jaeger 中按 Trace ID 查询。`stack:start:observability` 不会执行 `demo:prepare`，需要演示数据时再执行一次 `pnpm demo:prepare`。

## 7. 停止

```bash
pnpm stack:stop         # 停止全部托管服务（先 SIGTERM，5 秒后仍存活则 SIGKILL）
pnpm stack:stop:infra   # 同上，并 docker compose down（含 Jaeger）
```

`stack:stop:infra` 不会删除 Docker 数据卷。要彻底清空数据库数据:

```bash
docker compose -f infra/local/docker-compose.yml --profile observability down -v
```

## 8. 单独启动服务

每个服务和前端都提供 `start` 脚本（会先构建再启动），例如:

```bash
pnpm --filter @web3-cex/ledger-service start
pnpm --filter @web3-cex/api-gateway start
pnpm --filter @web3-cex/trader-web start
cargo run --manifest-path engines/matching-engine/Cargo.toml
pnpm demo:simulator   # 单独运行做市商 + 模拟链 + 水龙头
```

单独启动前请先启动基础设施并初始化表结构:

```bash
docker compose -f infra/local/docker-compose.yml up -d
pnpm db:prepare:demo
```

### 8.1 内部服务鉴权

`identity-service`、`wallet-service`、`ledger-service`、`order-service`、`settlement-service`、`risk-service` 默认只监听 `127.0.0.1`，并要求每个请求带 HMAC 签名头（`x-internal-service-name`、`x-internal-service-timestamp`、`x-internal-service-signature`）。

- `pnpm stack:start` 会自动为所有调用方和被调方注入同一个本地密钥（默认 `web3-cex-local-internal-auth`），并把 `INTERNAL_SERVICE_CALLER_NAME` 设为服务名。
- 根目录 `scripts/` 下的演示与测试脚本在未设置环境变量时也使用同一个默认值，调用名为 `demo-scripts`。
- **服务本身没有默认密钥。** 单独启动任何服务（包括调用方如 `api-gateway`、`ops-console`、`blockchain-indexer`、`market-data-service`）时，必须在同一运行面显式设置相同的密钥:

```bash
export INTERNAL_SERVICE_AUTH_SECRET=web3-cex-local-internal-auth
pnpm --filter @web3-cex/ledger-service start
```

相关变量:

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `INTERNAL_SERVICE_AUTH_SECRET` | 服务端无默认；脚本默认 `web3-cex-local-internal-auth` | 共享 HMAC 密钥，调用方与被调方必须一致 |
| `INTERNAL_SERVICE_CALLER_NAME` | 各服务默认是自己的服务名 | 签名中的调用方名称 |
| `INTERNAL_SERVICE_ALLOWED_CALLERS` | 各被调服务内置白名单 | 逗号分隔，覆盖允许的调用方 |
| `INTERNAL_SERVICE_AUTH_MAX_SKEW_MS` | `30000` | 签名时间戳允许的最大偏差 |
| `INTERNAL_SERVICE_BIND_HOST` | `127.0.0.1` | 上述 6 个内部服务的监听地址 |

安全设计的细节见 [security.md](./security.md)。

## 9. 重要环境变量

服务**不会自动加载 `.env` 文件**。各服务和前端目录下的 `.env.example` 列出了可配置项及本地默认值，代码中的默认值与之对应；需要覆盖时通过 shell 环境变量传入（`stack:start` 会把当前 shell 的环境变量传给所有子进程）。

| 变量 | 作用于 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 各服务 | 见第 4 节 | 服务监听端口 |
| `DATABASE_URL` | 各使用 PostgreSQL 的服务 | `postgres://web3:web3@127.0.0.1:5432/web3_cex` | 数据库连接 |
| `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS` | `wallet-service` | 代码默认 `86400`；`stack:start` 传入 `0` | 新增地址 / 修改 2FA 后的提现冷却期。演示冷却期: `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS=120 pnpm stack:start` |
| `WITHDRAWAL_REQUIRE_2FA` | `wallet-service` | `false` | 设为 `true` 时所有提现强制 2FA |
| `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_BY_ASSET` | `wallet-service` | `USDT=5000,USDC=5000,ETH=2,BTC=0.1,SOL=50` | 超过阈值的提现需双人复核 |
| `WITHDRAWAL_KYC_LIMITS_*` | `wallet-service` | 见 `.env.example` | 各 KYC 等级的单笔 / 日提现限额 |
| `OPS_REQUIRE_TWO_FACTOR` | `identity-service` | `true` | 运营账户登录是否要求 TOTP |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT` | 各 Node 服务 | 关闭 / `http://127.0.0.1:4318` | OpenTelemetry 追踪 |
| `TRADER_WEB_DEMO_MODE` | `trader-web` | `true` | 是否显示「一键登录演示账户」与水龙头 |
| `DEMO_MAKERS_ENABLED` | `demo-simulator` | 开启 | 设为 `false` 关闭做市商 |
| `DEMO_CHAIN_BLOCK_MS` / `DEMO_CHAIN_REQUIRED_CONFIRMATIONS` | `demo-simulator` | `1500` / `12` | 模拟链出块间隔与确认数 |
| `DEMO_*_URL`、`DEMO_DATABASE_URL` 等 | 根目录脚本 | 本地默认地址 | 覆盖脚本访问的服务地址，见 `scripts/mvp-demo-lib.mjs` 中的 `loadDemoConfig` |

市场与币种不通过环境变量配置，而是统一来自 `config/markets.json`，见 [config/README.md](../config/README.md)。

## 10. 根目录脚本一览

| 脚本 | 说明 |
| --- | --- |
| `pnpm build` | 构建所有 workspace 包 |
| `pnpm typecheck` | 所有包的 TypeScript 类型检查 |
| `pnpm check:structure` | 检查仓库必需的文件与目录是否存在 |
| `pnpm check:markets` | 构建后校验各服务 / 前端 / 脚本的市场与币种列表都派生自 `config/markets.json` |
| `pnpm db:prepare:core` | 初始化 ledger / identity / wallet / indexer / custody / order / settlement / risk 的表结构 |
| `pnpm db:prepare:demo` | `db:prepare:core` + `ops-console` 的表结构 |
| `pnpm stack:start` | 启动基础设施、构建、初始化表结构并启动全部服务 |
| `pnpm stack:start:observability` | 同上，并启动 Jaeger、开启追踪 |
| `pnpm stack:status` | 查看托管服务状态、PID、端口和日志路径 |
| `pnpm stack:stop` | 停止全部托管服务 |
| `pnpm stack:stop:infra` | 停止全部托管服务并 `docker compose down` |
| `pnpm demo:up` | `stack:start` + `demo:prepare` |
| `pnpm demo:reset` | 暂停做市商，清空 PostgreSQL / Redis / ClickHouse 演示数据和撮合引擎订单簿 |
| `pnpm demo:bootstrap` | 写入种子用户、资产、充值地址、提币白名单和簿内流动性，恢复做市商 |
| `pnpm demo:prepare` | `demo:reset` + `demo:bootstrap` |
| `pnpm demo:simulator` | 单独运行 `demo-simulator`（全栈启动时已包含，不要重复启动） |
| `pnpm demo:verify` | 检查网关 / 行情 / 运营后台可达，补齐种子数据后校验演示账户余额、充值地址和盘口 |
| `pnpm demo:verify:flow` | 跑一遍充值 → 交易 → 提现主链（API 级）；默认会先重置演示数据 |
| `pnpm demo:verify:evidence` | 运行主链验证并把结果渲染为可读的证据摘要 |
| `pnpm demo:verify:evidence:archive` / `:compare` / `:gate` | 归档证据快照、与基线比对、比对有漂移时失败 |
| `pnpm ops:totp` | 打印运营账户的 TOTP 动态码（建议加 `-s`） |
| `pnpm test:mvp` | 不依赖全栈的回归组合: `cargo test`、`check:markets`、`ops-console` 测试、`trader-web` smoke、成交领域回放 |
| `pnpm test:e2e` | 对已启动并播种的全栈依次运行全部 E2E 套件并输出 PASS / FAIL 汇总 |
| `pnpm test:features` | 功能端到端: API Key、WebSocket、手续费与 T 型账户、多市场、通知与流水、2FA / KYC / 双人复核、故障实验室 |
| `pnpm test:trader-web:smoke` | `trader-web` 包内测试（含基于 mock 的浏览器 smoke） |
| `pnpm test:trader-web:local` | `trader-web` 对真实全栈的浏览器 E2E |
| `pnpm test:ops-console:local` | `ops-console` 对真实全栈的浏览器 E2E |
| `pnpm test:trade-domain:replay` | 启动临时撮合引擎，验证成交事件序列、回放游标与结算幂等 |
| `pnpm docs:screenshots` | 在已启动并播种的全栈上重新生成 [使用手册](manual/README.md) 的截图（需要本机 Chrome，会执行演示下单、充值、提现等操作） |

## 11. 运行测试

### 11.1 单元测试与静态检查（对应 `.github/workflows/ci.yml`）

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm -r --if-present test
cargo test --manifest-path engines/matching-engine/Cargo.toml
pnpm check:structure
```

- 各包的 `test` 脚本会先构建，再用 `node --test` 运行 `dist/__tests__/*.test.js`。
- `ledger-service` 的 PostgreSQL 并发测试只有在设置 `LEDGER_TEST_DATABASE_URL` 时才会执行，例如:

  ```bash
  docker compose -f infra/local/docker-compose.yml up -d postgres
  LEDGER_TEST_DATABASE_URL=postgres://web3:web3@127.0.0.1:5432/web3_cex pnpm --filter @web3-cex/ledger-service test
  ```

- `trader-web` 的浏览器 smoke 测试找不到 Chrome 时会被跳过。macOS 默认使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他系统通过 `TRADER_WEB_SMOKE_CHROME_PATH` 指定。

`pnpm test:mvp` 是另一组不需要全栈运行的回归组合。设置 `DEMO_MAIN_FLOW_VERIFY=true` 或 `TRADER_WEB_LOCAL_E2E=true` 时，它会额外运行主链验证或 `trader-web` 本地 E2E（这两项需要全栈）。

### 11.2 全栈 E2E（对应 `.github/workflows/e2e.yml`）

```bash
cargo build --manifest-path engines/matching-engine/Cargo.toml   # 预编译，避免首次 cargo run 超时
pnpm demo:up
pnpm test:e2e
pnpm stack:stop:infra
```

`pnpm test:e2e` 依次运行以下套件，任一失败即停止:

| 顺序 | 套件 | 内容 |
| --- | --- | --- |
| 1 | `demo:verify` | 标准演示基线 |
| 2 | `demo:verify:flow` | 充值 → 交易 → 提现主链（API） |
| 3 | `test:features` | 功能端到端，结束时要求对账无不一致 |
| 4 | `test:trader-web:local` | 交易前台浏览器 E2E |
| 5 | `test:ops-console:local` | 运营后台浏览器 E2E |

说明:

- 浏览器 E2E 需要本机 Chrome。非 macOS 环境通过 `TRADER_WEB_SMOKE_CHROME_PATH` 和 `OPS_CONSOLE_E2E_CHROME_PATH` 指定路径（CI 中为 `/usr/bin/google-chrome`）。
- `test:features` 可以只跑部分段落，例如 `node scripts/verify-feature-e2e.mjs lab`；可选段落为 `apikey`、`websocket`、`fees`、`sol`、`notifications`、`security`、`lab`。
- E2E 会修改演示数据（KYC 等级、余额等），结束后执行 `pnpm demo:prepare` 即可恢复基线。
- 服务日志在 `.runtime/full-stack/logs/`，CI 失败时会上传这一目录。
