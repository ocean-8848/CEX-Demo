import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { OrderModule } from "./http/order.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(OrderModule, {
    rawBody: true
  });
  const port = Number(process.env.PORT ?? "3009");
  const host = process.env.INTERNAL_SERVICE_BIND_HOST ?? "127.0.0.1";

  app.enableShutdownHooks();
  await app.listen(port, host);
  Logger.log(`order-service listening on http://${host}:${port}`, "OrderBootstrap");
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
