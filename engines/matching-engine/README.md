# Matching Engine

Rust 实现的现货撮合引擎，`order-service` 通过 TCP（按行 JSON）与它通信。

职责:

- 接收标准化订单指令
- 在内存订单簿中完成撮合
- 产出确定性成交回报
- 不直接操作用户余额

当前实现:

- 每个市场一本内存订单簿（`bids` / `asks` 两个有序列表），按 symbol 首次使用时自动建簿
- 价格优先 / 时间优先撮合，支持 `limit` / `market` 与 `gtc` / `ioc` / `fok`
- 指令（JSON 字段 `action`）：`submit`、`seed`（回放挂单，不触发撮合）、`cancel`、`snapshot`、`reset`（清簿，可选重置序号）、`restore`（恢复 execution / batch 序号）
- 成交回报带递增的 execution / batch 序号，配合 `order-service` 的 `replay-engine` 从数据库重建订单簿
- 单元测试覆盖撮合规则、定点数解析与确定性回放：`cargo test --manifest-path engines/matching-engine/Cargo.toml`

运行:

- 全栈脚本会以 `cargo run --manifest-path ./engines/matching-engine/Cargo.toml` 启动它
- 环境变量：`MATCHING_ENGINE_HOST`（默认 `127.0.0.1`）、`PORT`（默认 `3011`）

## 定点数表示

引擎内部不使用 `f64`，价格和数量统一用 `i128` 定点数（`src/decimal.rs`）表示：

- 精度固定为 18 位小数，与账本的 18 位 NUMERIC 对齐。`1` 存为 `10^18` 个最小单位，`0.05` 存为 `5 × 10^16`。
- 输入：协议中的价格、数量仍是十进制字符串，由 `decimal::parse` 转为整数。负数、空串、科学计数法、超过 18 位小数、溢出等都会被拒绝（错误码沿用 `INVALID_PRICE` / `INVALID_QUANTITY`）。
- 输出：成交数量、剩余数量等计算结果由 `decimal::format` 输出规范字符串（去掉末尾 0，如 `3200`、`0.05`）；价格和未被改动的 seed 数量原样回显输入文本。TCP JSON 协议字段不变。
- 撮合只用到加、减、比较，全部是精确整数运算；剩余量要么恰好为 0，要么不为 0，不需要 `1e-8` 之类的 epsilon。

为什么浮点数不适合撮合：

- 二进制浮点无法精确表示 `0.1`、`0.2` 等十进制数：`0.1 + 0.2 != 0.3`，`0.1 + 0.7 = 0.7999999999999999`。
- 浮点撮合可能输出 `0.400000000000000022` 这样的成交量，与账本记账金额对不上，结算时会出现"粉尘"差额。
- 为了掩盖误差引入的 epsilon 会误伤真实的小额订单（例如把 `0.000000001` 当成 0），FOK 判断也可能因误差错误地拒绝/接受。
- 定点整数让同一组输入的输出逐字节一致，便于确定性回放（见 `full_replay_produces_byte_identical_output` 测试，测试中通过注入固定时钟消除 `executedAt` 的差异）。

## 延伸阅读

- [06 订单与撮合](../../learning/06-order-matching.md)
- [故障实验室](../../docs/fault-lab.md)（撮合引擎重置实验）
