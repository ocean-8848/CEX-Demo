import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { BlockchainIndexerModule } from "./http/blockchain-indexer.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(BlockchainIndexerModule);
  const port = Number(process.env.PORT ?? "3003");

  app.enableShutdownHooks();

  await app.listen(port);
  Logger.log(
    `blockchain-indexer listening on http://127.0.0.1:${port}`,
    "BlockchainIndexerBootstrap"
  );
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
