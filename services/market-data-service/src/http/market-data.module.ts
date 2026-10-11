import { Module } from "@nestjs/common";

import { MarketDataController } from "./market-data.controller.js";
import { MarketDataHttpService } from "./market-data-http.service.js";

@Module({
  controllers: [MarketDataController],
  providers: [MarketDataHttpService]
})
export class MarketDataModule {}
