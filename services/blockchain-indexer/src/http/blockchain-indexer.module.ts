import { Module } from "@nestjs/common";

import { BlockchainIndexerController } from "./blockchain-indexer.controller.js";
import { BlockchainIndexerExceptionFilter } from "./blockchain-indexer-exception.filter.js";
import { BlockchainIndexerHttpService } from "./blockchain-indexer-http.service.js";

@Module({
  controllers: [BlockchainIndexerController],
  providers: [BlockchainIndexerHttpService, BlockchainIndexerExceptionFilter]
})
export class BlockchainIndexerModule {}
