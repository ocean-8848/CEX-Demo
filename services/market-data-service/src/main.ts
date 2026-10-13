import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { MarketDataHttpService } from "./http/market-data-http.service.js";
import { MarketDataModule } from "./http/market-data.module.js";
import { MarketDataRealtimeServer } from "./http/market-data-realtime-server.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(MarketDataModule);
  const realtimeServer = new MarketDataRealtimeServer(app.get(MarketDataHttpService));
  realtimeServer.attach(app.getHttpServer());

  const port = Number(process.env.PORT ?? "3012");
  const host = process.env.MARKET_DATA_BIND_HOST ?? "127.0.0.1";
  app.enableShutdownHooks();
  await app.listen(port, host);
  Logger.log(
    `market-data-service listening on http://${host}:${port}`,
    "MarketDataBootstrap"
  );

  process.on("SIGTERM", () => {
    void realtimeServer.close();
  });
  process.on("SIGINT", () => {
    void realtimeServer.close();
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
