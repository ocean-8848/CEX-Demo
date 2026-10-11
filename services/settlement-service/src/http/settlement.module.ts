import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { SettlementController } from "./settlement.controller.js";
import { SettlementExceptionFilter } from "./settlement-exception.filter.js";
import { SettlementHttpService } from "./settlement-http.service.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";

@Module({
  controllers: [SettlementController],
  providers: [
    SettlementHttpService,
    SettlementExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class SettlementModule {}
