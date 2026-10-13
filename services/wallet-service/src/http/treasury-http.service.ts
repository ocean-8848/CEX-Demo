import { Injectable } from "@nestjs/common";

import { TreasuryService } from "../application/treasury-service.js";
import type { TreasuryRepository } from "../domain/treasury-repository.js";
import { HttpTreasuryCustodyClient, HttpTreasuryLedgerClient } from "../infrastructure/http-treasury-clients.js";
import { InMemoryTreasuryRepository } from "../infrastructure/in-memory-treasury-repository.js";
import { PostgresTreasuryRepository } from "../infrastructure/postgres-treasury-repository.js";
import { loadTreasuryConfigFromEnv } from "../infrastructure/treasury-config.js";
import { WalletHttpService } from "./wallet-http.service.js";

/** Wires the treasury module onto the wallet-service database (or memory store). */
@Injectable()
export class TreasuryHttpService {
  readonly treasury: TreasuryService;

  constructor(walletHttpService: WalletHttpService) {
    const { repository, pool } = walletHttpService.sharedStore;
    const treasuryRepository: TreasuryRepository = pool
      ? new PostgresTreasuryRepository(pool, pool)
      : new InMemoryTreasuryRepository(repository);

    this.treasury = new TreasuryService(
      treasuryRepository,
      new HttpTreasuryCustodyClient(process.env.CUSTODY_ADAPTER_BASE_URL ?? "http://127.0.0.1:3004"),
      new HttpTreasuryLedgerClient(process.env.LEDGER_SERVICE_BASE_URL ?? "http://127.0.0.1:3001"),
      loadTreasuryConfigFromEnv()
    );
  }
}
