import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { LedgerController } from "./ledger.controller.js";
import { LedgerExceptionFilter } from "./ledger-exception.filter.js";
import { LedgerHttpService } from "./ledger-http.service.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";

@Module({
  controllers: [LedgerController],
  providers: [
    LedgerHttpService,
    LedgerExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class LedgerModule {}
