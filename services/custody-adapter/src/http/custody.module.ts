import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { CustodyController } from "./custody.controller.js";
import { CustodyExceptionFilter } from "./custody-exception.filter.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";
import { CustodyHttpService } from "./custody-http.service.js";

@Module({
  controllers: [CustodyController],
  providers: [
    CustodyHttpService,
    CustodyExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class CustodyModule {}
