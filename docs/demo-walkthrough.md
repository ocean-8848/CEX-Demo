# 演示导览

这份文档是一份按步骤走的演示脚本：先逛一遍用户前台 `trader-web`，再逛一遍运营后台 `ops-console`，最后跑通四条端到端场景。每一步都写明了参与的后端服务，并给出对应的学习章节，方便把“页面上点了什么”和“交易所里发生了什么”对上。

阅读前提：全栈已经启动并完成演示数据初始化（`pnpm demo:up`）。环境搭建、端口和常见启动问题见 [getting-started.md](./getting-started.md)。

## 1. 演示基线

| 项目 | 值 |
| --- | --- |
| 用户前台 `trader-web` | <http://127.0.0.1:3013> |
| 运营后台 `ops-console` | <http://127.0.0.1:3006> |
| Jaeger（可选） | <http://127.0.0.1:16686>，只有用 `pnpm stack:start:observability` 启动时才有 |
| 默认市场 | `ETH-USDT`（`config/markets.json` 的 `defaultMarket`），另有 `BTC-USDT`、`SOL-USDT` |
| 演示链 | 由 `demo-simulator` 模拟的单条本地 EVM 链，每 1.5 秒出一个块，确认阈值 12 |
| 手续费 | Maker 0.05%，Taker 0.1%；买方手续费以 base 资产（如 `ETH`）扣，卖方以 quote 资产（`USDT`）扣 |

`demo-simulator` 会用两个做市账户在每个市场持续挂单、偶尔吃单，所以盘口价格会围绕参考价小幅波动。下单时请以当前订单簿为准，不要照抄文档里的价格。

### 1.1 演示账户

这些账户由 `pnpm demo:prepare`（即 `demo:reset` + `demo:bootstrap`）创建，定义在 `scripts/mvp-demo-lib.mjs`。

| 用途 | 邮箱 | 密码 | 说明 |
| --- | --- | --- | --- |
| 交易用户 | `demo-trader@example.com` | `DemoTraderPass123!` | 预置不少于 25,000 USDT 与 5 ETH；KYC 等级为「未认证」；登录页「⚡ 一键登录演示账户」就是这个账户 |
| 运营管理员 | `ops-admin@example.com` | `OpsAdminPass123!` | 角色 `ops_admin`，拥有全部后台权限；TOTP 种子 `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` |
| 运营复核人 | `ops-reviewer@example.com` | `OpsReviewerPass123!` | 角色 `ops_reviewer`，只能看总览、审核提现、看审计；TOTP 种子 `KRUGKIDROVUWG2ZAMJZG653OEBTG66BA` |

运营后台登录必须填 TOTP 动态码。动态码 30 秒滚动，同一个码只能用一次。在仓库根目录取当前动态码：

```bash
pnpm -s ops:totp            # ops-admin
pnpm -s ops:totp reviewer   # ops-reviewer
```

另有两个做市账户 `maker-ask@example.com`、`maker-bid@example.com`，由 `demo-simulator` 使用，演示时不需要登录。

### 1.2 演示数据弄乱了怎么办

```bash
pnpm demo:prepare   # 恢复标准演示数据
pnpm demo:verify    # 校验余额、充值地址、盘口和后台模块
```

故障实验室留下的故障不需要重置数据：在实验室页签点「一键恢复全部」即可，见 [fault-lab.md](./fault-lab.md)。

## 2. 学习辅助：学习模式与场景导览

`trader-web` 内置两个学习辅助工具，建议演示全程打开。

**学习模式**：点顶栏的「🎓 学习模式」，右侧会出现「幕后发生了什么」抽屉。下单、撤单、领取测试币、提现时，抽屉会按时间顺序列出请求经过的服务（如 `api-gateway` → `risk-service` → `ledger-service` → `matching-engine`）。点服务名可以看它的职责和代码目录。用 `pnpm stack:start:observability` 启动时，事件旁边会出现「查看 trace ↗」，直接跳到 Jaeger 里这次请求的调用链；不开追踪时只显示 trace id。

**场景导览**：点页面左下角的「🧭 场景导览」，可以选择四个内置场景：

| 场景 | 内容 | 对应本文 |
| --- | --- | --- |
| 完成第一笔交易 | 下一笔立即成交的买单，看冻结、撮合、结算 | [5.1](#51-第一笔交易) |
| 充值并观察确认数 | 用测试水龙头充值，看确认数涨到阈值后入账 | [5.2](#52-充值) |
| 提现并在运营后台审核 | 提交提现，到运营后台批准，看链上确认 | [5.3](#53-提现与审核) |
| 排查一次结算异常 | 在故障实验室暂停结算消费者，观察后恢复 | [5.4](#54-排查一次结算异常) |

每一步会高亮要操作的页面区域，并根据真实的订单、成交、充值、提现状态自动打勾；没有自动判定规则的步骤（例如在运营后台点按钮）需要手动点「我已完成」。全部完成后显示「🎉 场景完成」。导览进度保存在浏览器本地，刷新页面不会丢失。

## 3. 用户前台 `trader-web` 导览

顶栏导航：未登录时只有「首页」「交易」；登录后增加「资产」「订单」「账户」，以及「账户」连接状态点、通知铃铛和用户菜单。用户菜单里有「资产总览」「资金流水」「订单中心」「账户与 API」「退出登录」。

`trader-web` 本身是一个 React 单页应用加一个很薄的 Node Web Host：Web Host 托管静态资源、注入运行时配置，并把 `/api/*` 同源代理到 `api-gateway`、`market-data-service` 和 `demo-simulator`。会话保存在 HttpOnly Cookie `tw_session` 里，页面脚本读不到；写请求带 `x-csrf-token` 请求头。

### 3.1 首页（`#/`）

1. 打开 <http://127.0.0.1:3013>。
2. 顶部是三个市场卡片（`BTC-USDT` / `ETH-USDT` / `SOL-USDT`），显示最新价、24h 涨跌和迷你走势。
3. 「一笔订单的旅程」是一张交互式服务图，点任意服务看它的职责和代码位置。
4. 「上手三步」分别链接到登录、充值和交易页。
5. 顶栏「行情」状态点应为实时状态：未登录也能看公共行情。

| 涉及服务 | 学习章节 |
| --- | --- |
| `market-data-service`（ticker、K 线、公共 WebSocket） | [../learning/02-system-architecture.md](../learning/02-system-architecture.md)、[../learning/08-market-data.md](../learning/08-market-data.md) |

### 3.2 登录与注册（`#/login`）

1. 点「登录 / 体验演示账户」进入登录页。
2. 点「⚡ 一键登录演示账户」，或在表单里手填 `demo-trader@example.com` / `DemoTraderPass123!`。
3. 也可以切到「注册」页签注册新账户。新账户余额为 0，注册后去「资产」页用测试水龙头领币。
4. 登录页右侧「登录时发生了什么？」解释了 Web Host → `api-gateway` → `identity-service` 的过程。
5. 账户开启 2FA 后，登录需要填写「二次验证码」，也可以用一次性恢复码（`xxxx-xxxx`）代替。

登录成功后，「行情」「账户」两个状态点都应为实时状态，表示公共和私有 WebSocket 都已连上。

| 涉及服务 | 学习章节 |
| --- | --- |
| `api-gateway`（登录限流、会话校验）、`identity-service`（密码、TOTP、签发 session） | [../learning/03-account-identity-security.md](../learning/03-account-identity-security.md) |

### 3.3 交易页（`#/trade/ETH-USDT`）

页面布局：

| 区域 | 内容 |
| --- | --- |
| 顶部 | 交易对选择器与 24h 行情（涨跌、最高、最低、成交量、成交额、成交笔数） |
| 左侧 | 「现货市场」列表，点击切换交易对，URL 随之变化 |
| 中间 | K 线图；「订单簿 / 最新成交」页签，订单簿卖单在上、买单在下，中间显示价差 |
| 右侧 | 下单表单（`#order-form`） |
| 下方 | 「当前委托 / 历史委托 / 成交记录 / 资产」页签，可勾选「只看当前交易对」 |

**下单表单**：

- 「买入 / 卖出」切换方向；「限价 / 市价」切换类型。
- 限价单可以选择有效方式（Time in Force）：
  - `GTC`：一直有效，未成交部分挂在订单簿直到成交或撤单。
  - `IOC`：立即成交或取消，能成交多少成交多少，剩余立即撤销。
  - `FOK`：全部成交或取消，不能一次全部成交就整单撤销。
- 市价单按对手盘最优价逐档成交，未成交部分立即撤销（按 IOC 处理）。
- 点订单簿任意一档价格会自动填入价格（并切到限价）。
- 「25% / 50% / 75% / 100%」按可用余额计算数量。
- 表单下方显示成交额和预估手续费，并根据价格是否穿过对手盘标出是 Maker 还是 Taker。
- 每笔下单都带 `Idempotency-Key`，重复提交只会返回第一次的结果。

**演示一笔可撤单的挂单**：

1. 选「买入」「限价」「GTC」，价格填一个低于最优买价 1%–2% 的值，数量 `0.05`，点「买入 ETH」。价格不要偏离参考价超过 20%，否则会被 `risk-service` 拒单。
2. 在「当前委托」看到新订单，「资产」页签里 USDT 的「冻结」增加。
3. 点该行的「撤单」（有多笔挂单时也可以点「全部撤销」）。订单移到「历史委托」，状态为已撤销，冻结回落。

**演示一笔立即成交的订单**：

1. 打开学习模式。
2. 点订单簿卖盘最低的一档价格，数量 `0.05`，点「买入 ETH」。
3. 学习模式抽屉里出现「撮合过程回放」卡片：逐档展示这笔买单吃掉了卖盘哪几档、每档成交多少、剩余多少，支持「播放 / 暂停」「上一步」「下一步」「重播」。撮合回放只在学习模式打开时生成。
4. 右上角弹出成交提示，订单进入「历史委托」。
5. 切到「成交记录」，可以看到角色（Maker / Taker）和手续费。

可以再用 `IOC` / `FOK` 各下一笔数量较大的单，对比“部分成交后撤销剩余”和“整单撤销”的区别。

| 涉及服务 | 学习章节 |
| --- | --- |
| `api-gateway` → `order-service` → `risk-service`（数量、步长、价格偏离、市场是否暂停）→ `ledger-service`（冻结）→ `matching-engine`（价格优先、时间优先）→ `settlement-service` → `ledger-service`（分录）→ `market-data-service` / `api-gateway`（推送） | [../learning/06-order-matching.md](../learning/06-order-matching.md)、[../learning/09-risk-control.md](../learning/09-risk-control.md)、[../learning/08-market-data.md](../learning/08-market-data.md) |

### 3.4 T 型账户视图

在「成交记录」里点一笔成交（或该行的「T 型账户」按钮），打开「成交分录 · T 型账户」弹窗：

- 头部显示方向、时间、你在这笔成交中是「Maker 挂单方」还是「Taker 吃单方」，以及「✓ 借贷平衡」标记。
- T 型账户按账户角色（你、对手方、平台结算账户、平台手续费账户）列出借（Debit）贷（Credit）。对手方只显示角色，不展示账户信息。
- 「分录明细（按结算顺序）」列出每一条分录，手续费分录单独标注。
- 底部按币种重新求和，展示借方合计、贷方合计是否相等。这个校验在浏览器里重新计算，不依赖后端的结论。
- 账本以“平台对用户的负债”记账：用户账户贷方表示余额增加，借方表示余额减少。

如果结算还没完成，弹窗会显示「结算中」或「这笔成交还没有入账」。这就是“成交 ≠ 结算完成”的直观证据，[5.4](#54-排查一次结算异常) 会专门制造这个状态。

| 涉及服务 | 学习章节 |
| --- | --- |
| `settlement-service`（生成分录）、`ledger-service`（双分录账本） | [../learning/05-ledger.md](../learning/05-ledger.md)、[../learning/07-clearing-settlement-fees.md](../learning/07-clearing-settlement-fees.md)、[ledger-service-design.md](./ledger-service-design.md) |

### 3.5 订单中心（`#/orders`）

全部委托和成交明细，可以按交易对和状态筛选，并附有一张订单生命周期说明卡。

### 3.6 资产页（`#/assets`）

1. 「资产总览」显示总资产估值、可用、冻结（冻结 = 下单冻结 + 提现冻结），「我的资产」表按币种列出可用、冻结、总额，并有充值、提现、交易快捷链接。
2. 右侧面板有「充值」「提现」两个页签；下方是「充值记录」「提现记录」页签，带状态步骤条。
3. 可以用 `#/assets?action=deposit` 或 `#/assets?action=withdraw` 直接打开对应面板。

**充值地址**：选择币种后显示充值地址。演示用户已预置 `USDT` 和 `ETH` 的充值地址；其他币种需要先点「生成 … 充值地址」。

**测试水龙头**：

1. 在「🚰 测试水龙头」里选一个预设金额（预设来自 `config/markets.json`，例如 `1 ETH` / `5 ETH`、`1,000 USDT` / `10,000 USDT`），点「模拟转入」。
2. `demo-simulator` 把一笔转账写进当前区块并报告给 `blockchain-indexer`。如果你还没有该币种的充值地址，水龙头会先自动生成一个。
3. 水龙头下方显示「x/12 确认」进度；「充值记录」里这笔充值先是确认中，确认数随出块增加，到 12 个确认后变为已入账，余额增加。整个过程约 20 秒。

**提现**：

1. 切到「提现」页签，选择币种，提现地址选地址簿里的 `Demo Safe Address`（演示用户已预置，并已加入白名单）。也可以输入新的 EVM 地址后点「保存到地址簿」。
2. 填数量。表单下方实时显示网络手续费、到账数量、账本冻结金额（数量 + 手续费），以及当前 KYC 等级的单笔限额和今日剩余额度。
3. 如果金额超过大额阈值，会提示「大额提现，需两名运营人员复核」。
4. 已开启 2FA 时必须填「二次验证码（必填）」。
5. 可以先点「预校验」，再点「提交提现」。
6. 提交后「提现记录」出现新单，状态为待审核，资产「冻结」增加。

提现会在提交时校验以下规则（`wallet-service`）：

| 规则 | 默认值 |
| --- | --- |
| KYC 分级限额（单笔 / 每日，按 UTC 自然日） | 未认证：USDT 1,000 / 2,000，ETH 0.5 / 1；L1：USDT 10,000 / 20,000，ETH 5 / 10；L2：USDT 100,000 / 200,000，ETH 50 / 100 |
| 双人复核阈值（严格大于才触发） | USDT 5000、USDC 5000、ETH 2、BTC 0.1、SOL 50（`WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_BY_ASSET`） |
| 强制 2FA | 关闭；`WITHDRAWAL_REQUIRE_2FA=true` 时未开启 2FA 的账户无法提现 |
| 安全冷却期 | 代码默认 24 小时，`pnpm stack:start` 传 `0` 关闭；可用 `WITHDRAWAL_SECURITY_COOLDOWN_SECONDS=120 pnpm stack:start` 演示 |

演示用户默认是「未认证」，所以小额演示请用不超过 0.5 ETH 或 1,000 USDT 的金额；要演示双人复核，先把账户提到 L1（见 [3.8](#38-账户页account)）。

| 涉及服务 | 学习章节 |
| --- | --- |
| 充值：`demo-simulator` → `blockchain-indexer`（确认数）→ `wallet-service`（充值单）→ `ledger-service`（入账） | [../learning/04-wallet-custody.md](../learning/04-wallet-custody.md) |
| 提现：`api-gateway` → `wallet-service`（白名单、限额、2FA、冷却期）→ `ledger-service`（冻结） | [../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)、[../learning/09-risk-control.md](../learning/09-risk-control.md) |

### 3.7 资金流水（`#/assets/ledger`）

资产页右上角的「资金流水 / 对账单」，或用户菜单里的「资金流水」。

- 每一行都来自 `ledger-service` 的账本：充值入账、提现冻结 / 出账 / 解冻、下单冻结 / 委托解冻、成交支出 / 收入、调账。
- 列：时间、类型、币种、变动、手续费、变动后余额（总额，悬停可看可用 / 冻结）、来源。成交行带「T 型账户」入口。
- 可以按币种、类型、日期筛选，可以勾选「显示冻结 / 解冻」，支持分页。
- 「导出 CSV」导出当前筛选条件下的全部行（UTF-8 BOM + CRLF，金额为纯小数字符串，带公式注入防护）。

| 涉及服务 | 学习章节 |
| --- | --- |
| `ledger-service`（分录与冻结事件） | [../learning/05-ledger.md](../learning/05-ledger.md) |

### 3.8 账户页（`#/account`）

页面标题为「账户与安全」，从上到下依次是：

1. **个人信息**：昵称、邮箱、用户 ID、账户状态、现货账户。
2. **当前会话**：认证方式为「Session Token · HttpOnly Cookie（页面脚本不可读）」，以及签发 / 过期时间和私有推送状态。
3. **二次验证（TOTP 2FA）**：
   - 点「开启二次验证」，用身份验证器扫描二维码（二维码在浏览器本地生成），或复制密钥手动添加。
   - 输入 6 位动态码，点「验证并开启」。随后弹出「保存你的恢复码」，恢复码只显示这一次。
   - 开启后可以「重新生成恢复码」或「关闭二次验证」（关闭时可用动态码或恢复码）。
   - 开启后，退出再登录需要动态码；每个恢复码只能用一次。
4. **身份认证与提现限额**：
   - 显示当前 KYC 等级（新用户为「未认证」）和各币种的单笔限额、每日限额、今日已用、今日剩余。
   - 填写演示 KYC 申请：选申请等级，填「姓名（演示）」和「证件号（演示，虚构即可）」，点「提交认证申请」。不做真实身份核验，证件号只保存后 4 位。
   - 申请提交后显示等待运营审核；运营在后台批准后刷新本页，限额随等级提升。
   - 冷却期生效时显示「安全冷却期：…后暂停提现，还需等待 …」。
5. **API Key**：
   - 填备注，勾选权限范围：「读取」必选，「交易」可选，「提现」需显式勾选。点「创建 API Key」。
   - 弹窗显示 Key ID（`ak_…`，公开，放在 `X-API-Key` 请求头）和 Secret（`sk_…`，只显示这一次）。
   - 「如何用 API Key 调用接口（HMAC-SHA256 签名）」给出签名示例。请求需要 `X-API-Key`、`X-API-Timestamp`、`X-API-Nonce`、`X-API-Signature`；时间戳允许 5 分钟漂移，nonce 重复使用会被拒绝。细节见 [api-gateway README](../services/api-gateway/README.md)。
   - 列表里可以「吊销」Key。

| 涉及服务 | 学习章节 |
| --- | --- |
| `identity-service`（会话、2FA、恢复码、KYC 申请、API Key）、`api-gateway`（HMAC 验签、nonce 防重放）、`wallet-service`（按 KYC 等级校验提现限额） | [../learning/03-account-identity-security.md](../learning/03-account-identity-security.md)、[security.md](./security.md) |

### 3.9 通知中心

登录后顶栏有通知铃铛，显示未读数。

- 充值到账、提现审核与上链进度会出现在这里，点一条通知会跳到对应的充值或提现记录并标记已读。
- 「全部已读」后刷新页面或换设备，已读状态保持不变：已读状态保存在 `wallet-service`。
- 首屏通过 REST 拉取，之后通过私有 WebSocket 的 `notifications` 频道增量推送。
- 成交、充值到账、提现状态变化和错误还会以 Toast 形式弹出。

## 4. 运营后台 `ops-console` 导览

### 4.1 登录

1. 打开 <http://127.0.0.1:3006>。
2. 填 `ops-admin@example.com` / `OpsAdminPass123!`，「二次验证码（TOTP）」填 `pnpm -s ops:totp` 输出的 6 位动态码。登录页底部「演示账户与验证码」折叠区也写了这些信息。
3. 登录后左侧导航分三组：「概览」「业务」「风控与运维」。导航和按钮按当前账户的权限点显示，无权限的操作会被隐藏或禁用，后端同样会拒绝。
4. 顶栏有业务追踪搜索框、告警状态、主题切换、「打开交易前台 ↗」和「退出」。

会话保存在 HttpOnly Cookie `ops_session` 里，写请求带 `x-csrf-token`。每个写操作都写入操作审计。

`ops-console` 由一个 NestJS BFF（聚合各后端服务）和一个 React 单页前端组成，详见 [ops-console README](../apps/ops-console/README.md)。

### 4.2 页面一览

| 分组 | 页面（路由） | 主要内容 | 对应服务 |
| --- | --- | --- | --- |
| 概览 | 运营总览（`#/dashboard`） | 待审核提现、系统告警、已结算成交、累计手续费、账本对账、待投递通知；待审核提现列表、告警、模块状态 | 全部模块的健康摘要 |
| 概览 | 业务追踪（`#/trace`） | 输入任意业务主键跨模块联查 | `identity` / `wallet` / `ledger` / `blockchain-indexer` / `custody` / `order` / `settlement` 等 |
| 业务 | 提现审核（`#/withdrawals`） | 审核队列、批量批准 / 拒绝、双人复核、审计轨迹 | `wallet-service`、`custody-adapter` |
| 业务 | 充值与链上（`#/deposits`） | 充值记录、待确认观察、链重组游标 | `wallet-service`、`blockchain-indexer` |
| 业务 | 用户与资产（`#/users`） | 用户、KYC 审核、余额、提现地址簿 | `identity-service`、`ledger-service`、`wallet-service` |
| 业务 | 交易与结算（`#/trading`） | 订单、成交、结算、订单簿健康 | `order-service`、`matching-engine`、`settlement-service` |
| 业务 | 市场管理（`#/markets`） | 市场状态、运行时暂停 / 恢复交易 | `risk-service`、`config/markets.json` |
| 风控与运维 | 账本对账（`#/ledger`） | 余额对账、账户回放、Outbox | `ledger-service` |
| 风控与运维 | 系统运维（`#/system`） | 告警、托管通道、恢复队列、事件总线、自动化作业、实验室 | `custody-adapter`、`order-service`、`settlement-service` 等 |
| 风控与运维 | 操作审计（`#/audit`） | 后台操作审计、提现状态迁移 | `ops-console` |

后台里蓝色的 ID（`userId`、`orderId`、`tradeId`、`withdrawalId`、`txHash` 等）都可以点击，直接跳到对应页面或业务追踪。

### 4.3 运营总览（`#/dashboard`）

- 顶部指标卡：待审核提现（点击进入审核队列）、系统告警、已结算成交、累计手续费、账本对账（是否一致）、待投递通知。
- 「待审核提现」列表可以直接批准或拒绝。
- 「告警」列出账本、链上观察、托管等来源的告警；全部在阈值内时显示「一切正常」。
- 「模块状态」卡片，点卡片跳到该模块相关的运维视图。

### 4.4 提现审核（`#/withdrawals`）

1. 默认是「待审核」页签；「全部提现」页签可以按状态、币种、userId 筛选。
2. 列表的「规则校验」列显示 `2FA`、`白名单`、`KYC 等级`、`双人复核` 标签和当日已用额度。
3. 单笔操作：点行内「批准」或「拒绝」。批量操作：勾选多行后批量批准或拒绝。
4. 点一行打开「提现详情」抽屉，包含：状态步骤条（申请 → 审核通过 → 托管广播 → 链上确认）、「审核要点」（用户状态、白名单、2FA、账本冻结是否足够）、「基本信息」、「审计轨迹」、「托管广播」、「用户通知」，以及「在业务追踪中查看 →」。
5. 批准时在确认弹窗填写审核备注，点「确认批准并广播」。批准后 `wallet-service` 调用 `custody-adapter` 签名广播，模拟链确认 12 个区块后完成，账本最终扣除冻结资金。
6. 拒绝时填写拒绝原因，冻结的金额和手续费退回用户可用余额，用户收到通知。

**大额提现双人复核**：

- 金额严格大于双人复核阈值（默认 `5000 USDT` / `2 ETH` / `0.1 BTC`）的提现需要两名不同的运营人员先后批准。
- 第一位批准后，列表显示「双人复核」标签和「1/2 已批准」，状态仍为审核中，不会广播。
- 同一个运营再次批准会被拒绝（`WITHDRAWAL_SAME_APPROVER`），按钮提示「你已批准过，需要另一名运营人员复核」。
- 第二位运营看到的按钮是「复核批准」（详情抽屉里是「复核批准并广播」）。批准后显示「2/2 已批准」，进入广播和链上确认。
- 详情抽屉的「双人复核」区列出每一位批准人和时间；「审计轨迹」记录 `first_approved` → `approved` 两次状态迁移。

学习章节：[../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)、[../learning/09-risk-control.md](../learning/09-risk-control.md)。

### 4.5 充值与链上（`#/deposits`）

- 顶部指标：待确认充值观察、待确认提现观察、链重组游标、Indexer 状态。
- 「充值记录」页签：按状态、币种筛选。
- 「待确认观察」页签：尚未达到确认阈值的充值观察，显示区块和确认进度。卡住的观察可以单笔或批量「重放」（按确认数重放，等待入账）或「关闭」（关闭后这笔观察不再入账，例如链重组后交易已不存在）。

学习章节：[../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)。

### 4.6 用户与资产（`#/users`）

| 页签 | 内容 |
| --- | --- |
| 用户 | 按邮箱 / 昵称 / userId 搜索，按用户类型（客户 / 运营）筛选；点开用户详情可以看二次验证状态、「KYC 等级」、「资产（账本）」、「最近委托」、「充提记录」；可以「冻结用户」/「解冻用户」 |
| KYC 审核 | 按状态（待审核 / 已通过 / 已拒绝 / 全部）列出申请；操作「批准 L1」「批准 L2」「拒绝」 |
| 余额 | 全局余额，可按币种和账户类型（用户现货 / 平台国库 / 手续费 / 期初权益）筛选 |
| 提现地址簿 | 所有用户的提现地址，可以「加入」/「移出」白名单 |

- 冻结用户后，该用户的会话与 API Key 鉴权都会被拒绝，无法下单或提现。
- 用户详情的「KYC 等级」区可以直接「调整为 未认证 / L1 / L2」，需要填写调整原因。
- 批准 KYC 后用户立即获得对应等级的提现限额，审核人和备注写入 KYC 事件和操作审计。

学习章节：[../learning/03-account-identity-security.md](../learning/03-account-identity-security.md)。

### 4.7 交易与结算（`#/trading`）

- 顶部按市场显示结算笔数、成交量、成交额、手续费收入、待恢复 / 失败。
- 「订单」页签：按状态（挂单中 / 部分成交 / 完全成交 / 已撤销 / 已拒绝 / 恢复中）和 userId 筛选。
- 「成交」页签：最近成交，含买方、卖方和结算状态。
- 「结算」页签：按状态筛选，分列「卖方费 (quote)」「买方费 (base)」；未结算的行可以「重试结算」。
- 「订单簿健康」页签：「数据库 vs 撮合引擎」对比 DB 挂单、引擎买单、引擎卖单和异常数，下方是「异常清单」。撮合引擎的订单簿在内存中，`order-service` 的数据库是事实源；两者不一致时点「从数据库重建引擎订单簿」。

学习章节：[../learning/06-order-matching.md](../learning/06-order-matching.md)、[../learning/07-clearing-settlement-fees.md](../learning/07-clearing-settlement-fees.md)。

### 4.8 市场管理（`#/markets`）

1. 列出 `config/markets.json` 中的全部市场：当前状态、配置默认状态、价格 / 数量步长、最小数量、参考价 / 偏离上限、运行时覆盖（原因、操作人、时间）。
2. 点某个市场的「暂停交易」，填暂停原因并确认。
3. 回到前台对该市场下单：新委托被 `risk-service` 拒绝（错误码 `MARKET_HALTED`），已有挂单仍可撤销。`demo-simulator` 也会停止在该市场报价。
4. 点「恢复交易」：删除运行时覆盖，市场回到配置文件中的默认状态。

暂停 / 恢复需要 `ops.markets.manage` 权限，由 `risk-service` 持久化并写入操作审计。新增 / 下架市场、改步长或费率需要编辑 `config/markets.json` 后重启服务，见 [config/README.md](../config/README.md)。

学习章节：[../learning/09-risk-control.md](../learning/09-risk-control.md)。

### 4.9 业务追踪（`#/trace`）

1. 在输入框粘贴任意业务主键：提现单、订单、成交、充值单、用户、账本账户或链上交易哈希。「主键类型」默认「自动识别」。也可以在顶栏搜索框直接输入。
2. 结果包含：「已推导出的关联主键」、「跨模块链路」（身份、钱包、账本、链上观察、托管、订单、撮合、结算等）、「命中的业务对象」、「关联记录」和「完整追踪结果（JSON）」。
3. 用 `pnpm stack:start:observability` 启动时，还会出现「OpenTelemetry 调用链：…」，点「在 Jaeger 中查看 ↗」看这笔请求跨服务的 span 树。

### 4.10 账本对账（`#/ledger`）

- 顶部指标：对账结果、活跃冻结、Outbox 待发布、死信、账本告警。
- 「余额对账」：点「重新对账」，逐个比较余额快照与“分录净额 − 活跃冻结”。可以勾选「显示一致的余额」。
- 「账户回放」：在对账表某一行点「回放」，或输入账户 ID，按时间顺序重放分录与每一次冻结 / 解冻 / 结算，比较「快照可用 / 冻结」和「回放可用 / 冻结」。
- 「投递 Outbox 事件」手动驱动一轮 Outbox 投递。`pnpm stack:start` 会常驻运行 `ledger-outbox-publisher`，积压持续增长通常意味着 publisher 或 Kafka 异常。
- 页面底部「对账原理」解释了分录净额、活跃冻结、期望值和回放的含义。

学习章节：[../learning/05-ledger.md](../learning/05-ledger.md)、[ledger-service-design.md](./ledger-service-design.md)。

### 4.11 系统运维（`#/system`）

| 页签 | 内容 |
| --- | --- |
| 告警 | 账本、链上观察、托管、钱包、交易域各数据源的告警与指标明细 |
| 托管通道 | 托管状态、熔断中的通道、不健康通道、路由表（优先级、健康、熔断器、连续失败、广播成功 / 失败）；可以执行健康检查 |
| 恢复队列 | 「订单恢复队列（order-service）」「结算恢复队列（settlement-service）」和死信任务；可以处理一批、单笔触发恢复、死信重新入队 |
| 事件总线 | 「交易事件流运行报告」：`order-service` 把成交写入 Redis Stream（`trade.executed`），`settlement-service` 按 checkpoint 顺序消费；「手动作业」有「驱动结算消费一轮」「事件流维护（裁剪）」「自愈：检测滞后并回放」 |
| 自动化作业 | 作业模板、定时计划、最近执行；每次执行都写入操作审计 |
| 实验室 | 故障注入实验室，可直接用 `#/system?tab=lab` 打开，详见 [fault-lab.md](./fault-lab.md) |

学习章节：[../learning/13-reliability-security-incidents.md](../learning/13-reliability-security-incidents.md)。

### 4.12 操作审计（`#/audit`）

- 「后台操作」页签：每个写操作的时间、操作人、动作（如 `withdrawal.approve`）、权限、对象和结果，可以展开查看请求与响应；可以按动作和结果筛选。
- 「提现状态迁移」页签：每张提现单的每次状态迁移，含动作、操作方和状态变化。

## 5. 端到端场景

下面四个场景与前台「🧭 场景导览」的四个场景一一对应。建议全程打开学习模式。

### 5.1 第一笔交易

| 步骤 | 操作 | 观察 | 涉及服务 |
| --- | --- | --- | --- |
| 1 | `trader-web` 一键登录演示账户 | 顶栏出现「资产 / 订单 / 账户」 | `api-gateway`、`identity-service` |
| 2 | 打开「交易」，进入 `#/trade/ETH-USDT` | 订单簿持续变化（做市在跑） | `market-data-service` |
| 3 | 点卖盘最低价，数量 `0.05`，点「买入 ETH」 | 学习模式依次出现网关、风控、冻结、撮合事件，以及撮合过程回放 | `api-gateway` → `order-service` → `risk-service` → `ledger-service` → `matching-engine` |
| 4 | 切到「成交记录」 | 出现一笔成交，角色为 Taker，手续费以 ETH 计 | `matching-engine` → `settlement-service` |
| 5 | 点「T 型账户」 | 分录按账户角色展开，「✓ 借贷平衡」 | `settlement-service`、`ledger-service` |
| 6 | 到 `ops-console` →「交易与结算」→「成交」/「结算」 | 同一笔成交已结算，卖方费与买方费分列 | `order-service`、`settlement-service` |
| 7 | 把 `tradeId` 粘贴到「业务追踪」 | 订单、成交、结算、账本分录串在一起 | 多个模块 |

学习章节：[../learning/06-order-matching.md](../learning/06-order-matching.md)、[../learning/07-clearing-settlement-fees.md](../learning/07-clearing-settlement-fees.md)、[../learning/05-ledger.md](../learning/05-ledger.md)。

### 5.2 充值

| 步骤 | 操作 | 观察 | 涉及服务 |
| --- | --- | --- | --- |
| 1 | `trader-web` →「资产」→「充值」，选 `ETH` | 显示充值地址 | `wallet-service` |
| 2 | 测试水龙头选 `1 ETH`，点「模拟转入」 | 学习模式出现 `demo-simulator`、`blockchain-indexer` 事件 | `demo-simulator` → `blockchain-indexer` |
| 3 | 看水龙头进度和「充值记录」 | 确认数逐块增加，约 20 秒到 12 个确认 | `demo-simulator`（出块）→ `blockchain-indexer` |
| 4 | 达到阈值 | 状态变为已入账，ETH 可用余额增加，铃铛出现到账通知 | `wallet-service` → `ledger-service` |
| 5 | 打开「资金流水」 | 出现一条充值入账 | `ledger-service` |
| 6 | 到 `ops-console` →「充值与链上」 | 「充值记录」里能找到这笔充值；确认过程中「待确认观察」里能看到它 | `wallet-service`、`blockchain-indexer` |

为什么要等 12 个确认：确认数不够时，链重组可能把交易回滚。可以在故障实验室的「链重组」实验里亲眼看到确认数跌回再重新累积，见 [fault-lab.md](./fault-lab.md)。

学习章节：[../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)。

### 5.3 提现与审核

**普通提现**：

| 步骤 | 操作 | 观察 | 涉及服务 |
| --- | --- | --- | --- |
| 1 | `trader-web` →「资产」→「提现」，币种 `ETH`，地址选 `Demo Safe Address`，数量 `0.1` | 显示手续费 `0.001 ETH`、账本冻结 `0.101 ETH`、未认证等级的限额 | `wallet-service` |
| 2 | 点「预校验」，再点「提交提现」 | 「提现记录」出现待审核单，ETH 冻结增加 | `api-gateway` → `wallet-service` → `ledger-service`（冻结） |
| 3 | `ops-console` 用 `ops-admin` 登录 →「提现审核」 | 待审核队列出现这笔提现 | `ops-console` → `wallet-service` |
| 4 | 点「批准」，填审核备注，「确认批准并广播」 | 状态进入已广播 | `wallet-service` → `custody-adapter` |
| 5 | 等待约 20 秒 | 状态变为已确认，前台「提现记录」同步推进，铃铛收到通知；冻结被最终扣除 | `demo-simulator` → `blockchain-indexer` → `wallet-service` → `ledger-service` |
| 6 | 「操作审计」 | 查到这次 `withdrawal.approve` | `ops-console` |

**大额提现双人复核**：

1. 前台「账户」页提交 L1 认证申请；在 `ops-console` →「用户与资产」→「KYC 审核」点「批准 L1」。回到前台刷新，USDT 单笔限额变为 10,000。
2. 前台发起一笔 `6000 USDT` 的提现（大于 5000 的阈值），表单会提示「大额提现，需两名运营人员复核」。
3. `ops-admin` 批准：列表显示「双人复核」和「1/2 已批准」，提现不会广播。再点一次会提示「你已批准过，需要另一名运营人员复核」。
4. 退出，用 `ops-reviewer@example.com` / `OpsReviewerPass123!`（动态码用 `pnpm -s ops:totp reviewer`）登录，点「复核批准」。显示「2/2 已批准」，随后进入广播和链上确认。
5. 提现详情的「双人复核」与「审计轨迹」能看到两次批准及各自的操作人。

学习章节：[../learning/04-wallet-custody.md](../learning/04-wallet-custody.md)、[../learning/09-risk-control.md](../learning/09-risk-control.md)、[../learning/03-account-identity-security.md](../learning/03-account-identity-security.md)。

### 5.4 排查一次结算异常

这个场景演示“成交了但没结算”是什么样子，以及运营如何定位和恢复。

| 步骤 | 操作 | 观察 | 涉及服务 |
| --- | --- | --- | --- |
| 1 | `ops-console` →「系统运维」→「实验室」，在「① 暂停结算消费者」点「暂停结算消费（2 分钟）」 | 卡片显示消费者「已暂停」和倒计时 | `ops-console` → `settlement-service` |
| 2 | 回到 `trader-web` 交易页，下一笔立即成交的买单 | 成交出现，但它的「T 型账户」显示「结算中」或「这笔成交还没有入账」，冻结资金没有释放 | `order-service`、`matching-engine` |
| 3 | 回到实验室 | 「已成交未结算」数字随做市成交持续增长 | `settlement-service` |
| 4 | 「系统运维」→「事件总线」 | checkpoint 滞后在增长；此时点「驱动结算消费一轮」会返回 `409 SETTLEMENT_EVENT_SUBSCRIBER_PAUSED` | `order-service`（Redis Stream）、`settlement-service` |
| 5 | 实验室点「恢复消费」（或等到期自动恢复） | 消费者从 checkpoint 补齐积压的成交，滞后归零 | `settlement-service` → `ledger-service` |
| 6 | 前台重新打开 T 型账户 | 显示「✓ 借贷平衡」，冻结释放 | `ledger-service` |
| 7 | 「账本对账」点「重新对账」 | 全部一致 | `ledger-service` |

结算消费者暂停期间，撮合照常进行；这正是“撮合”和“结算”分成两个阶段、通过事件流异步衔接的结果。其他三个故障实验见 [fault-lab.md](./fault-lab.md)。

学习章节：[../learning/07-clearing-settlement-fees.md](../learning/07-clearing-settlement-fees.md)、[../learning/13-reliability-security-incidents.md](../learning/13-reliability-security-incidents.md)。

## 6. 讲解顺序建议

如果要把这个项目讲给别人听，可以按下面的顺序：

1. 先讲 `trader-web`，打开学习模式，让对方边点边看到背后的服务时间线。
2. 再讲 `api-gateway`：客户请求如何进入系统（会话、限流、幂等、API Key 验签）。
3. 再讲 `order-service` → `matching-engine` → `settlement-service` → `ledger-service`：交易为什么要拆成多个阶段。
4. 再讲 `wallet-service` → `custody-adapter` → `blockchain-indexer`：充值和提现为什么必须是异步状态机。
5. 最后讲 `ops-console`：内部如何审核、观察和排查；用「业务追踪」把同一笔业务串起来，再用故障实验室演示一次“出问题 → 观察 → 恢复”。

更深入的架构说明见 [architecture.md](./architecture.md)，事件定义见 [event-catalog.md](./event-catalog.md)，常见问题见 [troubleshooting.md](./troubleshooting.md)。
