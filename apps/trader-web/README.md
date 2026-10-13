# Trader Web

用户交易前台（默认端口 `3013`）。界面按真实中心化交易所的布局组织，同时内置「学习模式」，把每个操作背后经过的服务实时展示出来。

## 职责与主链定位

- `React SPA` + 一个极薄的 Node Web Host（`src/server.ts`）：托管静态资源、注入运行时配置，并把 HTTP 同源代理到后端，浏览器无需处理 CORS
- 公共行情走 `market-data-service`（REST + 公共 WebSocket），私有数据走 `api-gateway`（REST + 私有 WebSocket，带序号续传）
- 演示环境下通过 `/api/demo/*` 访问 `demo-simulator`（测试水龙头、模拟链状态）

## 页面

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `#/` | 首页 | 实时行情卡片 + 迷你走势、「一笔订单的旅程」交互式架构图、上手三步 |
| `#/trade/ETH-USDT` | 交易 | 交易对选择、24h 行情、K 线（lightweight-charts）、订单簿（深度条，点击价格填单）、最新成交、下单面板（限价 / 市价、GTC / IOC / FOK、百分比仓位、按本人 VIP 等级费率的手续费预估）、当前委托 / 历史委托 / 成交记录（手续费列显示成交时记录的等级与费率）/ 资产 |
| `#/assets` | 资产 | 总资产估值、余额（可用 / 冻结）、充值地址、测试水龙头（确认数进度条）、提现（地址簿、预校验、冻结金额说明）、充提记录与状态步骤条 |
| `#/assets/ledger` | 资金流水 | 账本流水逐行展示（充值入账 / 提现冻结·出账·解冻 / 下单冻结·委托解冻 / 成交支出·收入 / 调账），含手续费、变动后余额（总额，悬停看可用 / 冻结）、来源链接与成交的 T 型账户入口；按币种 / 类型（含手续费）/ 日期筛选、分页；「导出 CSV」导出当前筛选的全部行（UTF-8 BOM + CRLF，金额为纯小数字符串，公式注入防护） |
| `#/orders` | 订单中心 | 全部委托与成交明细、按交易对 / 状态筛选、订单生命周期说明 |
| `#/account` | 账户 | 个人信息、会话；二次验证（扫码绑定 TOTP、一次性恢复码、凭动态码关闭 / 重新生成恢复码）；身份认证与提现限额（KYC 等级、各币种单笔 / 每日限额与今日已用、冷却期提示、演示 KYC 申请表）；手续费等级（当前 VIP 等级与来源、Maker / Taker 费率、30 日成交量、距下一等级的差额与进度条、等级阶梯表、各市场实际费率）；API Key 创建 / 吊销（密钥只显示一次）、HMAC 签名调用示例 |
| `#/login` | 登录 / 注册 | 含「一键登录演示账户」；开启 2FA 后需要动态码，也可输入恢复码 |

二维码由 `src/client/lib/qr.ts` 在浏览器本地生成（无第三方依赖，ISO 18004 字节模式 + Reed-Solomon，`src/__tests__/qr.test.ts` 做编解码往返与格式位校验），2FA 密钥不会发给任何第三方二维码服务。提现面板会提前展示当前币种限额、是否必须填写动态码和冷却期；`WITHDRAWAL_2FA_NOT_ENABLED` 映射为「请先在账户页开启二次验证」，`WITHDRAWAL_SECURITY_COOLDOWN` 显示剩余等待时间。

全局：顶栏通知中心（铃铛 + 未读数 + 下拉列表；中文标题按 eventType 映射，点击跳转到对应提现 / 充值记录并标记已读，支持「全部已读」；已读状态由 wallet-service 持久化，刷新 / 换设备保持；REST 首屏 + 私有 WS `notifications` 频道增量）、深色 / 浅色主题、行情与账户连接状态、Toast 通知（成交、充值到账、提现状态变化、错误）、学习模式抽屉（服务时间线 + 服务职责说明）、移动端自适应。

学习功能：

- **成交分录 / T 型账户**：交易页和订单中心的「成交记录」中点击任意一行（或「T 型账户」按钮），弹窗展示这笔成交产生的全部账本分录：冻结消耗 → 结算中转账户、基础资产交割、计价资产交割、双边手续费。每个账户（我的现货账户 / 对手方 / 平台结算中转账户 / 平台手续费账户）画成一张 T 型账户（借 | 贷），并逐笔、逐资产校验借方合计 = 贷方合计（浏览器端用 bigint 重新计算，不只信服务端标记）。数据来自 `GET /api/gateway/trades/:tradeId/journals`，对手方不暴露任何 id。
- **撮合过程回放**：打开学习模式后下单，抽屉顶部会逐步动画展示新订单如何按价格优先、时间优先吃掉对手盘：命中了哪几档、每档几笔挂单、成交价 × 数量、在哪一档因限价停止，以及剩余数量的去向（挂入订单簿 / IOC 撤销 / FOK 整单拒绝）。输入是下单瞬间的盘口快照 + 订单返回后 `GET /trades?orderId=` 查到的本单（taker）成交，不需要改撮合引擎；纯逻辑在 `src/client/lib/match-explain.ts`。
- **引导场景**：`src/client/lib/tours.ts` 定义「登录演示账户」「完成第一笔交易」等分步场景，每一步根据交易所状态自动判定完成，由 `src/client/features/tour/tour-panel.tsx` 渲染。

## 代码结构

```text
src/
├── server.ts                 # Web Host：静态资源、/api/config、/api/session、/api/gateway|market|demo 代理、/api/realtime WS 转发
├── session.ts                # Cookie 会话与 CSRF 校验
├── main.ts
└── client/
    ├── main.tsx / app.tsx    # 入口、路由与页面外壳
    ├── lib/                  # 无 React 依赖的纯函数：api、records、router、types、notifications、statement（资金流水）、qr、tours、match-explain（撮合回放）、journals（T 型账户）、fee-tier（VIP 费率）（有单测）
    ├── state/
    │   ├── store.tsx         # 全局状态（useReducer）+ 业务动作 + REST 快照 + 双 WebSocket
    │   ├── socket.ts         # 指数退避自动重连的 WebSocket 封装
    │   ├── learn.ts          # 学习模式：服务说明与事件解释
    │   └── fee-tier.ts       # useFeeTier：本人 VIP 等级（GET /api/gateway/fees/tier，成交数变化时刷新）
    ├── components/           # 页面布局（layout）、通知铃铛；通用 UI 组件与格式化函数来自 @web3-cex/web-ui
    └── features/             # home / trade / assets / orders / account / auth / learn / tour
```

## 运行

```bash
pnpm --filter @web3-cex/trader-web build      # esbuild 打包客户端 + tsc 编译 Web Host
pnpm --filter @web3-cex/trader-web start
pnpm --filter @web3-cex/trader-web test       # 单测 + 基于 headless Chrome 的冒烟测试（mock 后端）
pnpm test:trader-web:local                    # 对真实全栈跑端到端（注册→下单→撤单→成交→水龙头充值→提现→断线重连）
```

`public/app.js` 是构建产物，不提交到仓库。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3013` | |
| `TRADER_WEB_TITLE` | `Web3 CEX Trader` | |
| `TRADER_WEB_GATEWAY_URL` | `http://127.0.0.1:3007` | |
| `TRADER_WEB_MARKET_DATA_URL` | `http://127.0.0.1:3012` | |
| `TRADER_WEB_GATEWAY_WS_URL` / `TRADER_WEB_MARKET_DATA_WS_URL` | 由 HTTP 地址推导 | |
| `TRADER_WEB_DEMO_MODE` | `true` | `false` 时隐藏水龙头与一键演示登录，并关闭 `/api/demo/*` |
| `TRADER_WEB_DEMO_SIMULATOR_URL` | `http://127.0.0.1:3014` | |
| `TRADER_WEB_DEMO_EMAIL` / `TRADER_WEB_DEMO_PASSWORD` | 种子演示账户 | 一键登录使用的账户 |
| `TRADER_WEB_COOKIE_SECURE` | `false` | `true` 时会话 Cookie 加 `Secure` |
| `TRADER_WEB_OPS_CONSOLE_URL` | `http://127.0.0.1:3006` | 引导场景中跳转运营后台的链接 |
| `TRADER_WEB_TRACING_UI_URL` | `OTEL_ENABLED=true` 时为 `http://127.0.0.1:16686` | 链路追踪 UI 链接 |

## 代理与接口

- `/api/gateway/* -> api-gateway /api/v1/gateway/*`
- `/api/market/* -> market-data-service /api/v1/market-data/*`
- `/api/demo/{status, faucet, faucet/:id} -> demo-simulator`（只放行这三个路由；做市商暂停等控制接口不暴露给浏览器）
- `GET /api/config`：运行时配置（`markets` / `defaultMarket` / `assets` 均派生自 `config/markets.json`：市场精度与费率、默认市场、币种网络、提现手续费、水龙头上限与快捷金额；`delisted` 市场不下发），浏览器端不硬编码任何市场或币种
- `GET /healthz`

## 浏览器会话

- 登录走 Web Host：`POST /api/session`（转发到网关 `/auth/sessions`），token 只写入 `tw_session` Cookie（`HttpOnly; SameSite=Strict; Path=/`，`TRADER_WEB_COOKIE_SECURE=true` 时加 `Secure`），响应体不含 token；`GET /api/session` 查询当前会话，`POST /api/session/logout` 吊销并清 Cookie。
- 代理到网关 / 模拟器的请求由 Web Host 附上 `Authorization: Bearer`，Cookie 不会转发给上游；带 Cookie 的写请求必须在 `x-csrf-token` 中回传可读的 `tw_csrf` Cookie（double-submit），否则 `403 CSRF_TOKEN_INVALID`。显式带 `Authorization` 的调用（脚本、API 示例）不受影响。
- 私有 WebSocket 连接同源 `/api/realtime`，Web Host 在升级请求上附 Bearer 头后转发给网关（网关握手支持 Authorization 头），浏览器保留原 Origin，因此网关的 Origin 校验仍然生效。
- 前端只在 localStorage 保存非敏感的 `trader-web:signed-in` 提示位；旧版本遗留的 `trader-web:token` 会在启动时清除。冒烟测试与本地 e2e 都断言页面脚本读不到 token。
- 实现：`src/session.ts`、`src/server.ts`（`handleSession` / `proxyPrivateWebSocket`）、`src/client/lib/api.ts`（`COOKIE_SESSION`）。

## 延伸阅读

- [03 账户、身份与安全](../../learning/03-account-identity-security.md)
- [06 订单与撮合](../../learning/06-order-matching.md)、[05 账本](../../learning/05-ledger.md)、[07 清算结算与手续费](../../learning/07-clearing-settlement-fees.md)
- [演示走查](../../docs/demo-walkthrough.md)、[API 契约](../../docs/api-contracts.md)
