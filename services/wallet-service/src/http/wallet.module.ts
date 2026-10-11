import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { WalletController } from "./wallet.controller.js";
import { WalletExceptionFilter } from "./wallet-exception.filter.js";
import { WalletHttpService } from "./wallet-http.service.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";

@Module({
  controllers: [WalletController],
  providers: [
    WalletHttpService,
    WalletExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class WalletModule {}
