import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { BlockchainIndexerController } from "./blockchain-indexer.controller.js";
import { BlockchainIndexerExceptionFilter } from "./blockchain-indexer-exception.filter.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";
import { BlockchainIndexerHttpService } from "./blockchain-indexer-http.service.js";

@Module({
  controllers: [BlockchainIndexerController],
  providers: [
    BlockchainIndexerHttpService,
    BlockchainIndexerExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class BlockchainIndexerModule {}
