import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { IdentityModule } from "./http/identity.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(IdentityModule, {
    rawBody: true
  });
  const port = Number(process.env.PORT ?? "3005");
  const host = process.env.INTERNAL_SERVICE_BIND_HOST ?? "127.0.0.1";

  app.enableShutdownHooks();

  await app.listen(port, host);
  Logger.log(
    `identity-service listening on http://${host}:${port}`,
    "IdentityBootstrap"
  );
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
