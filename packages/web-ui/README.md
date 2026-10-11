# @web3-cex/web-ui

`trader-web` 与 `ops-console` 共享的浏览器端基础库。

- `src/format.ts`：把服务返回的 18 位小数字符串格式化为可读数字、百分比、时间、短哈希等（纯函数）
- `src/ui.tsx`：Button、Badge、Tabs、Panel、Modal、Empty、Field、Progress、Steps、CopyButton、FeedDot、AssetIcon 等基础组件，以及 `Tone` / `FeedStatus` 类型
- `src/router.ts`：极简 hash 路由（`useHashRoute`、`navigate`、`href`）
- `styles/base.css`：设计 token（深色 / 浅色主题）与上述组件的样式；两个应用在构建时把它复制为 `/base.css`

构建：`pnpm --filter @web3-cex/web-ui build`（两个应用的 `prebuild` 会自动执行）。
