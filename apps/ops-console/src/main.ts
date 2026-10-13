import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OpsConsoleModule } from "./http/ops-console.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(OpsConsoleModule);
  const port = Number(process.env.PORT ?? "3006");
  const host = process.env.OPS_CONSOLE_BIND_HOST ?? "127.0.0.1";
  const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./public");

  app.enableShutdownHooks();
  app.useStaticAssets(staticRoot);

  await app.listen(port, host);
  Logger.log(
    `ops-console listening on http://${host}:${port}`,
    "OpsConsoleBootstrap"
  );
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
