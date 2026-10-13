import type { Server as HttpServer } from "node:http";
import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { currentTraceId } from "@web3-cex/telemetry";

import { ApiGatewayHttpService } from "./http/api-gateway-http.service.js";
import { ApiGatewayModule } from "./http/api-gateway.module.js";
import { ApiGatewayRealtimeServer } from "./http/api-gateway-realtime-server.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiGatewayModule, {
    rawBody: true
  });
  const port = Number(process.env.PORT ?? "3007");
  const host = process.env.GATEWAY_BIND_HOST ?? "127.0.0.1";
  const realtimePath = process.env.GATEWAY_WS_PATH ?? "/api/v1/gateway/realtime";

  app.enableShutdownHooks();
  // Expose the trace id so a request can be looked up in Jaeger (OTEL_ENABLED=true).
  // The gateway sets no CORS headers (browsers reach it through the trader-web proxy).
  app.use((_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => {
    const traceId = currentTraceId();
    if (traceId) {
      response.setHeader("x-trace-id", traceId);
    }
    next();
  });

  await app.listen(port, host);
  const realtimeServer = new ApiGatewayRealtimeServer(app.get(ApiGatewayHttpService));
  realtimeServer.attach(app.getHttpServer() as HttpServer);
  app.getHttpServer().once("close", () => {
    void realtimeServer.close();
  });
  Logger.log(
    `api-gateway listening on http://${host}:${port} and ws://${host}:${port}${realtimePath}`,
    "ApiGatewayBootstrap"
  );
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
