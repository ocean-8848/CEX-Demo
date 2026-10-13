import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { IdentityController } from "./identity.controller.js";
import { IdentityExceptionFilter } from "./identity-exception.filter.js";
import { IdentityHttpService } from "./identity-http.service.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";
import { LoginSecurityController } from "./login-security.controller.js";

@Module({
  controllers: [IdentityController, LoginSecurityController],
  providers: [
    IdentityHttpService,
    IdentityExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class IdentityModule {}
