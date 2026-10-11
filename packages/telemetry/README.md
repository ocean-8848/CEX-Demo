# @web3-cex/telemetry

Node 服务共享的 OpenTelemetry 链路追踪封装。默认关闭，`OTEL_ENABLED=true` 时才启动 SDK。

- `src/register.ts`：预加载入口，各服务以 `node --import @web3-cex/telemetry/register ./dist/main.js` 启动，保证在加载 `pg` / `redis` / `express` / `@nestjs/core` 之前装好 instrumentation
- `src/sdk.ts`：初始化 NodeSDK，自动埋点 HTTP、undici、Express、NestJS、pg、redis，按 OTLP HTTP 导出 trace
- `src/index.ts`：`withSpan`、`currentTraceId`，以及跨 Redis 事件传递上下文用的 `injectTraceContext` / `extractTraceContext` / `linkFromTraceContext`

关键环境变量:

- `OTEL_ENABLED`（默认关闭）
- `OTEL_SERVICE_NAME`（默认 `web3-cex-node`）
- `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（默认 `http://127.0.0.1:4318`）

本地可用 `pnpm stack:start:observability` 同时拉起 Jaeger（UI `http://127.0.0.1:16686`），见 [infra/local](../../infra/local/README.md)。

运行:

```bash
pnpm --filter @web3-cex/telemetry build
pnpm --filter @web3-cex/telemetry test
```

延伸阅读:

- [13 可靠性与安全事故](../../learning/13-reliability-security-incidents.md)
- [系统架构](../../docs/architecture.md)
