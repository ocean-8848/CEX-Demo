# 故障排查

本文按「启动 → 演示数据 → 服务间调用 → 业务链路 → 测试」的顺序整理本地运行时的常见问题。启动步骤与脚本说明见 [getting-started.md](./getting-started.md)。

## 1. 先看哪里

| 想知道什么 | 怎么看 |
| --- | --- |
| 哪些服务在跑、哪个端口被占用 | `pnpm stack:status` |
| 某个服务为什么起不来 / 报错 | `.runtime/full-stack/logs/<service>.log`（例如 `tail -n 100 .runtime/full-stack/logs/order-service.log`） |
| 基础设施容器是否正常 | `docker compose -f infra/local/docker-compose.yml ps`、`docker logs web3-cex-postgres` |
| 前台 / 模拟器是否存活 | `curl -s http://127.0.0.1:3013/healthz`、`curl -s http://127.0.0.1:3014/healthz` |
| 行情是否有数据 | `curl -s http://127.0.0.1:3012/api/v1/market-data/tickers` |
| 一笔请求在服务间如何流转 | 用 `pnpm stack:start:observability` 启动，在 Jaeger（<http://127.0.0.1:16686>）按 `x-trace-id` 查询 |

`stack:status` 的状态含义:

| 状态 | 含义 |
| --- | --- |
| `running` | 托管进程存活且端口可连接（无端口的 worker 只看进程） |
| `starting` | 进程存活但端口尚未监听 |
| `stopped` | 没有托管进程，端口空闲 |
| `port-in-use` | 端口被一个**不受 `stack:*` 管理**的进程占用 |

## 2. 启动问题

### 2.1 `Detected running services or occupied ports`

`stack:start` 在启动前会检查 `3001`–`3014` 各服务端口，任何一个不是 `stopped` 都会退出。

1. 先执行 `pnpm stack:stop`，停掉上一次托管启动的服务。
2. 如果仍有 `port-in-use`，说明有手工启动的服务或残留进程。找到并结束它:

   ```bash
   lsof -nP -iTCP:3007 -sTCP:LISTEN
   kill <pid>
   ```

3. 再次执行 `pnpm stack:start`（或 `pnpm demo:up`）。

### 2.2 Docker 未启动或基础设施端口冲突

- `Cannot connect to the Docker daemon`: 先启动 Docker Desktop / Docker 服务，再重试。
- `port is already allocated` / `address already in use`: 本机已有 PostgreSQL（`5432`）、Redis（`6379`）、Kafka（`9092`）或 ClickHouse（`8123` / `9000`）在运行。停止本机实例，或释放对应端口。compose 中的端口与服务默认连接地址是绑定的，不建议只改其中一边。
- 需要 `docker compose`（Compose v2）。只有旧版 `docker-compose` 时脚本会失败。

### 2.3 `db:prepare` 失败（连接被拒绝 / 数据库正在启动）

compose 没有健康检查，第一次 `docker compose up -d` 后 PostgreSQL 可能还在初始化，`pnpm db:prepare:demo` 会报 `ECONNREFUSED` 或 `the database system is starting up`。此时还没有服务被启动，等几秒后直接重跑即可:

```bash
pnpm stack:start --skip-infra
```

如果表结构损坏或想从零开始，删除数据卷后重新启动:

```bash
pnpm stack:stop:infra
docker compose -f infra/local/docker-compose.yml --profile observability down -v
pnpm demo:up
```

### 2.4 `matching-engine did not become ready on port 3011`

`stack:start` 用 `cargo run` 启动撮合引擎，最多等 45 秒。首次编译常常超过这个时间。先单独编译一次再启动:

```bash
cargo build --manifest-path engines/matching-engine/Cargo.toml
pnpm stack:start
```

也要确认 `cargo` 在 PATH 中（`cargo --version`）。

### 2.5 其他服务 `did not become ready`

启动失败时脚本会停掉已启动的服务并提示日志路径。打开对应的 `.runtime/full-stack/logs/<service>.log`，常见原因:

- 依赖的基础设施不可用（PostgreSQL / Redis / ClickHouse 未就绪）。
- 构建产物缺失: 使用了 `--skip-build` 但从未构建过。去掉该参数或先执行 `pnpm build`。
- 表结构缺失: 使用了 `--skip-db-prepare` 但数据库是新的。先执行 `pnpm db:prepare:demo`。

### 2.6 运行时状态残留

`.runtime/full-stack/pids/` 中进程已不存在的 PID 文件会被自动清理。如果手动删除过 `.runtime/`、或机器重启后进程还在，`stack:stop` 将找不到它们，表现为 `port-in-use`，按 2.1 处理。确认没有服务在运行后，可以安全地删除整个目录:

```bash
rm -rf .runtime/full-stack
```

## 3. 演示数据问题

### 3.1 `demo:prepare` / `demo:bootstrap` 报连接错误

这两个脚本通过 HTTP 调用各服务，必须在全栈运行后执行（`pnpm demo:up` 已经包含）。先用 `pnpm stack:status` 确认全部 `running`。

### 3.2 `demo:reset` 输出中有 `warnings`

- `settlement consumer did not drain before reset`: 结算消费者 15 秒内没有追上，通常无害；如果后续数据异常，再执行一次 `pnpm demo:prepare`。
- `redis cleanup skipped` / `clickhouse cleanup skipped`: 对应容器不可用。ClickHouse 清理会先走 HTTP（`8123`），失败后回退到 `docker exec web3-cex-clickhouse clickhouse-client`；两者都失败才会出现这条警告。检查容器状态后重跑。

### 3.3 盘口不动、K 线没有新数据

- `demo-simulator` 没在运行: `pnpm stack:status` 查看 `demo-simulator`。
- 做市商被暂停: `demo:reset`、`demo:verify:flow`、浏览器 E2E 等脚本会暂停做市商，正常结束时会恢复。脚本中途被打断时可能停留在暂停状态，执行 `pnpm demo:bootstrap`（会重新播种并恢复做市商），或直接:

  ```bash
  curl -sX POST http://127.0.0.1:3014/api/demo/makers -H 'content-type: application/json' -d '{"paused":false}'
  ```

- 市场被运营暂停: 被暂停的市场做市商不报价，新委托返回 `MARKET_HALTED`。在运营后台「市场管理」恢复，或执行 `pnpm demo:prepare`（会清空市场状态覆盖）。

### 3.4 跑完测试后演示数据变了

`demo:verify:flow` 默认会先重置演示数据（设置 `DEMO_VERIFY_FLOW_RESET=false` 可跳过）；`test:features` 会修改 KYC 等级和余额。执行 `pnpm demo:prepare` 即可回到标准基线。

## 4. 内部服务鉴权

`identity-service`、`wallet-service`、`ledger-service`、`order-service`、`settlement-service`、`risk-service` 要求 HMAC 签名头，且默认只监听 `127.0.0.1`。用 `pnpm stack:start` 启动时密钥会自动注入；单独启动服务或脚本时最容易在这里出错。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 被调服务返回 `503` `INTERNAL_SERVICE_AUTH_SECRET is not configured` | 被调服务启动时没有设置密钥（服务端没有默认值） | 以 `INTERNAL_SERVICE_AUTH_SECRET=web3-cex-local-internal-auth` 重新启动该服务 |
| 调用方报错 `INTERNAL_SERVICE_AUTH_SECRET is required for internal service calls` | 调用方（如 `api-gateway`、`ops-console`、`blockchain-indexer`）没有设置密钥 | 同上，为调用方设置相同的密钥 |
| `401` `Internal service request signature is invalid` | 调用方与被调方的密钥不一致 | 两边使用同一个值；根目录脚本未设置时默认 `web3-cex-local-internal-auth` |
| `401` `Missing internal service authentication headers` | 用 `curl` 等工具直接访问内部服务 | 改走 `api-gateway`（`3007`）或 `ops-console`（`3006`）；脚本里使用 `scripts/internal-service-auth.mjs` 生成签名头 |
| `401` `Caller <name> is not allowed` | 调用方名称不在被调服务白名单中 | 检查 `INTERNAL_SERVICE_CALLER_NAME`，或在被调方设置 `INTERNAL_SERVICE_ALLOWED_CALLERS` |
| `401` `Internal service request timestamp is stale` | 签名时间与服务器时间相差超过 30 秒 | 校准系统时间，或调大 `INTERNAL_SERVICE_AUTH_MAX_SKEW_MS` |
| 从容器或其他机器访问内部服务连接被拒绝 | 内部服务只监听 `127.0.0.1` | 本地学习场景下应在本机访问；确有需要时设置 `INTERNAL_SERVICE_BIND_HOST` |

各服务的维护脚本（`pnpm --filter <包名> <脚本>`）如果需要调用受保护服务，也要在同一个 shell 中导出相同的 `INTERNAL_SERVICE_AUTH_SECRET`。

## 5. 登录与账户

### 5.1 运营后台 TOTP 被拒

- `TWO_FACTOR_CODE_REUSED`: 同一用户的同一个动态码只能用一次。等 `pnpm -s ops:totp` 输出的剩余秒数归零后取新码。
- `TWO_FACTOR_INVALID_CODE`: 确认账户与命令对应（复核人要用 `pnpm -s ops:totp reviewer`），并检查本机时间是否准确。
- 种子账户不存在: 数据被重置过但没有重新播种，执行 `pnpm demo:prepare`。

### 5.2 前台「一键登录演示账户」失败

演示账户 `demo-trader@example.com` 由 `demo:bootstrap` 写入。执行过 `demo:reset` 而没有 `demo:bootstrap` 时会登录失败，执行 `pnpm demo:prepare`。

## 6. 资金与交易链路

### 6.1 充值一直停在确认中

前台水龙头和模拟充值依赖 `demo-simulator` 出块（默认 1.5 秒一块、12 个确认）。检查:

- `demo-simulator` 是否 `running`。
- 是否在故障实验室中暂停了出块（`/internal/lab/chain/halt`）。暂停会在设定时长后自动恢复，也可以在运营后台「系统运维 → 实验室」手动恢复，见 [fault-lab.md](./fault-lab.md)。

### 6.2 提现被拒绝或卡住

| 现象 | 常见原因 |
| --- | --- |
| 提交时被拒绝 | 超出 KYC 等级限额、低于最小金额、开启了强制 2FA（`WITHDRAWAL_REQUIRE_2FA=true`）但未提供有效动态码 |
| 新增地址 / 修改 2FA 后无法提现 | 处于安全冷却期。`stack:start` 默认传入 `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS=0`；**单独启动 `wallet-service` 时代码默认是 `86400`（24 小时）**，需显式设为 `0` |
| 一位运营批准后仍是待审核 | 金额超过双人复核阈值，需要第二位运营（`ops-reviewer@example.com`）批准，且两人不能是同一账户 |
| 批准后迟迟没有 `txHash` / 停在已广播 | `custody-adapter` 广播失败（检查是否注入了托管故障）或 `demo-simulator` 没有推进确认 |

### 6.3 下单失败或成交后余额不变

- 下单直接失败: 区分是风控拒绝（余额不足、`MARKET_HALTED`）、账本冻结失败，还是撮合引擎不可用（`matching-engine` 未运行）。错误信息中带有对应的错误码。
- 已成交但未结算: 查看 `settlement-service` 日志；如果在故障实验室中暂停了结算消费者，恢复后会自动补结算。运营后台「交易与结算」「系统运维」可以查看结算记录和恢复队列。
- 撮合引擎订单簿与数据库挂单不一致: 引擎订单簿只在内存中。引擎重启后，`order-service` 的自动同步（`ORDER_ENGINE_SYNC_INTERVAL_MS`，默认 2 秒）通常会在几秒内回放挂单；如果仍不一致（运营后台出现 `engine_missing_open_order` 异常），在运营后台执行「从数据库重建订单簿」，或执行 `pnpm demo:prepare` 回到基线。

### 6.4 账本对账不一致或 outbox 堆积

- 运营后台「账本对账」可以直接执行对账与 replay。
- `ledger-outbox-publisher` 负责把 outbox 事件发到 Kafka。Kafka 不可用时 outbox 会堆积；确认 `web3-cex-kafka` 容器正常、`ledger-outbox-publisher` 在运行。
- 命令行工具（会先构建；需要数据库可用）:

  ```bash
  pnpm --filter @web3-cex/ledger-service reconcile-balances
  pnpm --filter @web3-cex/ledger-service replay-account
  pnpm --filter @web3-cex/ledger-service check-alerts
  pnpm --filter @web3-cex/ledger-service drain-outbox-alerts
  ```

原则: 先跑只读检查，再执行修复动作；不要直接手改余额或状态列。账本设计见 [ledger-service-design.md](./ledger-service-design.md)。

### 6.5 其他服务的维护脚本

| 服务 | 脚本 |
| --- | --- |
| `wallet-service` | `deliver-notifications`、`reconcile-stale-withdrawals` |
| `blockchain-indexer` | `scan-evm`、`replay-evm`、`repair-backlog`、`check-alerts` |
| `custody-adapter` | `check-alerts`、`report-ops`、`sync-transfers` |
| `order-service` | `recover` |

用法均为 `pnpm --filter @web3-cex/<服务名> <脚本>`。`scan-evm`、`replay-evm` 面向真实 EVM RPC（`EVM_RPC_URL_*`），标准演示使用 `demo-simulator` 的模拟链，不需要它们。

## 7. 测试问题

### 7.1 `No Chrome executable found for ... local E2E`

浏览器 E2E 使用 `playwright-core` 驱动本机 Chrome，不会自动下载浏览器。macOS 默认路径为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他系统需要指定:

```bash
export TRADER_WEB_SMOKE_CHROME_PATH=/usr/bin/google-chrome   # trader-web smoke 与 local E2E
export OPS_CONSOLE_E2E_CHROME_PATH=/usr/bin/google-chrome    # ops-console local E2E
```

`pnpm --filter @web3-cex/trader-web test` 中的 smoke 测试在找不到 Chrome 时会被**跳过**而不是失败。

### 7.2 账本并发测试没有执行

`ledger-service` 的 PostgreSQL 并发测试只在设置 `LEDGER_TEST_DATABASE_URL` 时运行:

```bash
LEDGER_TEST_DATABASE_URL=postgres://web3:web3@127.0.0.1:5432/web3_cex pnpm --filter @web3-cex/ledger-service test
```

### 7.3 `test:e2e` / `test:features` 失败

- 必须先 `pnpm demo:up`，确保全栈运行并已播种。
- `test:e2e` 遇到第一个失败的套件就停止，末尾的汇总会显示是哪一个。可以单独重跑该套件，例如 `pnpm -s test:features`，或只跑某一段: `node scripts/verify-feature-e2e.mjs security`。
- 上一次失败可能留下脏数据或暂停的做市商，先执行 `pnpm demo:prepare` 再重跑。
- 同时查看 `.runtime/full-stack/logs/` 中相关服务的日志。

### 7.4 `test:trade-domain:replay` 失败

该脚本会用 `cargo run` 在随机端口启动一个临时撮合引擎，并直接引用 `services/*/dist` 下的构建产物。先执行 `pnpm build`，并确认 `cargo` 可用。
