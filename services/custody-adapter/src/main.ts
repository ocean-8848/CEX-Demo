import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { CustodyModule } from "./http/custody.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(CustodyModule);
  const port = Number(process.env.PORT ?? "3004");

  app.enableShutdownHooks();

  await app.listen(port);
  Logger.log(
    `custody-adapter listening on http://127.0.0.1:${port}`,
    "CustodyBootstrap"
  );
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
