import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { BlockchainIndexerModule } from "./http/blockchain-indexer.module.js";

async function bootstrap(): Promise<void> {
  // rawBody: the internal-service HMAC guard signs over the exact request bytes.
  const app = await NestFactory.create(BlockchainIndexerModule, {
    rawBody: true
  });
  const port = Number(process.env.PORT ?? "3003");
  const host = process.env.INTERNAL_SERVICE_BIND_HOST ?? "127.0.0.1";

  app.enableShutdownHooks();

  await app.listen(port, host);
  Logger.log(
    `blockchain-indexer listening on http://${host}:${port}`,
    "BlockchainIndexerBootstrap"
  );
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
