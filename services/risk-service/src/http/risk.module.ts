import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { RiskController } from "./risk.controller.js";
import { RiskExceptionFilter } from "./risk-exception.filter.js";
import { RiskHttpService } from "./risk-http.service.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";

@Module({
  controllers: [RiskController],
  providers: [
    RiskHttpService,
    RiskExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class RiskModule {}
