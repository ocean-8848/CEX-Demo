import { Injectable, type OnModuleDestroy } from "@nestjs/common";

import { MarketStatusService } from "../application/market-status-service.js";
import { RiskApplicationService } from "../application/risk-application-service.js";
import type { MarketStatusRepository, SetMarketStatusCommand } from "../domain/market-status.js";
import type { ValidateSpotOrderRiskCommand } from "../domain/types.js";
import { HttpLedgerClient } from "../infrastructure/http-ledger-client.js";
import { HttpMarketDataReferencePriceProvider } from "../infrastructure/http-market-data-reference-price-provider.js";
import { InMemoryMarketStatusRepository } from "../infrastructure/in-memory-market-status-repository.js";
import { PostgresMarketStatusRepository } from "../infrastructure/postgres-market-status-repository.js";
import { createRiskPool } from "../infrastructure/postgres.js";

@Injectable()
export class RiskHttpService implements OnModuleDestroy {
  private readonly applicationService: RiskApplicationService;
  private readonly marketStatusRepository: MarketStatusRepository;

  constructor() {
    // Market halt / resume overrides live in Postgres so they survive restarts;
    // RISK_MARKET_STATUS_STORE=memory keeps them in-process (tests, no DB).
    this.marketStatusRepository =
      process.env.RISK_MARKET_STATUS_STORE === "memory"
        ? new InMemoryMarketStatusRepository()
        : new PostgresMarketStatusRepository(createRiskPool());
    this.applicationService = new RiskApplicationService(
      new HttpLedgerClient(process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001"),
      {
        referencePriceProvider:
          process.env.RISK_REFERENCE_PRICE_MODE === "configured"
            ? undefined
            : new HttpMarketDataReferencePriceProvider(
                process.env.RISK_MARKET_DATA_URL ?? "http://127.0.0.1:3012"
              ),
        marketStatus: new MarketStatusService({
          repository: this.marketStatusRepository,
          cacheMs: Number(process.env.RISK_MARKET_STATUS_CACHE_MS ?? "1000")
        })
      }
    );
  }

  async validateSpotOrder(command: ValidateSpotOrderRiskCommand) {
    return this.applicationService.validateSpotOrder(command);
  }

  async listMarkets() {
    return this.applicationService.marketStatus.listMarkets();
  }

  async getMarket(market: string) {
    return this.applicationService.marketStatus.getMarket(market);
  }

  async setMarketStatus(command: SetMarketStatusCommand) {
    return this.applicationService.marketStatus.setStatus(command);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.marketStatusRepository instanceof PostgresMarketStatusRepository) {
      await this.marketStatusRepository.close();
    }
  }
}
