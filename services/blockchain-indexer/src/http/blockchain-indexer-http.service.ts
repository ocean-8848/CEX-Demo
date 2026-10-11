import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

import { BlockchainIndexerApplicationService } from "../application/blockchain-indexer-application-service.js";
import type { IndexerOpsOverview } from "../application/indexer-ops.js";
import type {
  CloseDepositObservationCommand,
  EvmDepositScanResult,
  EvmWithdrawalScanResult,
  IndexedDepositObservation,
  IndexedWithdrawalObservation,
  ListDepositObservationsQuery,
  ObservationType,
  ObserveDepositCommand,
  ObserveWithdrawalCommand,
  PagedResult,
  ReplayDepositObservationCommand,
  ScanCursor,
  ScanEvmDepositsCommand,
  ScanEvmWithdrawalsCommand
} from "../domain/types.js";
import { HttpWalletClient } from "../infrastructure/http-wallet-client.js";
import { InMemoryBlockchainIndexerRepository } from "../infrastructure/in-memory-blockchain-indexer-repository.js";
import { EvmRpcClient } from "../infrastructure/evm-rpc-client.js";
import { loadEvmScanConfigFromEnv } from "../infrastructure/evm-scan-config.js";
import { IndexerOpsReporter } from "../infrastructure/indexer-ops-reporter.js";
import { createBlockchainIndexerPool } from "../infrastructure/postgres.js";
import { PostgresBlockchainIndexerRepository } from "../infrastructure/postgres-blockchain-indexer-repository.js";
import type { BlockchainIndexerRepository } from "../domain/repository.js";

@Injectable()
export class BlockchainIndexerHttpService implements OnModuleDestroy {
  private readonly applicationService: BlockchainIndexerApplicationService;
  private readonly repository: BlockchainIndexerRepository;
  private readonly pool?: Pool;
  private readonly opsReporter?: IndexerOpsReporter;
  private readonly evmScanConfig = loadEvmScanConfigFromEnv();

  constructor() {
    const repositoryMode = process.env.BLOCKCHAIN_INDEXER_REPOSITORY ?? "postgres";

    if (repositoryMode === "memory") {
      this.repository = new InMemoryBlockchainIndexerRepository();
    } else {
      this.pool = createBlockchainIndexerPool();
      this.repository = new PostgresBlockchainIndexerRepository(this.pool, this.pool);
      this.opsReporter = new IndexerOpsReporter(
        this.pool,
        ({ rpcUrl }) => new EvmRpcClient(rpcUrl),
        this.evmScanConfig.rpcUrls
      );
    }

    this.applicationService = new BlockchainIndexerApplicationService(
      this.repository,
      new HttpWalletClient(process.env.WALLET_SERVICE_BASE_URL ?? "http://127.0.0.1:3002"),
      {
        confirmationThreshold: Number(process.env.INDEXER_CONFIRMATION_THRESHOLD ?? "12"),
        maxScanBlockRange: this.evmScanConfig.maxScanBlockRange,
        walletPageSize: this.evmScanConfig.walletPageSize,
        evmRpcUrls: this.evmScanConfig.rpcUrls,
        evmNativeAssetCodes: this.evmScanConfig.nativeAssetCodes,
        evmTokenContracts: this.evmScanConfig.tokenContracts,
        evmClientFactory: ({ rpcUrl }) => new EvmRpcClient(rpcUrl)
      }
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async observeDeposit(command: ObserveDepositCommand): Promise<IndexedDepositObservation> {
    return this.applicationService.observeDeposit(command);
  }

  async observeWithdrawal(
    command: ObserveWithdrawalCommand
  ): Promise<IndexedWithdrawalObservation> {
    return this.applicationService.observeWithdrawal(command);
  }

  async scanEvmDeposits(command: ScanEvmDepositsCommand): Promise<EvmDepositScanResult> {
    return this.applicationService.scanEvmDeposits(command);
  }

  async scanEvmWithdrawals(
    command: ScanEvmWithdrawalsCommand
  ): Promise<EvmWithdrawalScanResult> {
    return this.applicationService.scanEvmWithdrawals(command);
  }

  async getDepositObservation(observationId: string): Promise<IndexedDepositObservation | null> {
    return this.applicationService.getDepositObservation(observationId);
  }

  async listDepositObservations(
    query: ListDepositObservationsQuery
  ): Promise<PagedResult<IndexedDepositObservation>> {
    return this.applicationService.listDepositObservations(query);
  }

  async replayDepositObservation(
    command: ReplayDepositObservationCommand
  ): Promise<IndexedDepositObservation> {
    return this.applicationService.replayDepositObservation(command);
  }

  async closeDepositObservation(
    command: CloseDepositObservationCommand
  ): Promise<IndexedDepositObservation> {
    return this.applicationService.closeDepositObservation(command);
  }

  async getWithdrawalObservation(
    observationId: string
  ): Promise<IndexedWithdrawalObservation | null> {
    return this.applicationService.getWithdrawalObservation(observationId);
  }

  async getScanCursor(
    observationType: ObservationType,
    network: ObserveDepositCommand["network"]
  ): Promise<ScanCursor | null> {
    return this.applicationService.getScanCursor(observationType, network);
  }

  async acknowledgeReorg(network: ObserveDepositCommand["network"]) {
    return this.applicationService.acknowledgeReorg(network);
  }

  async getOpsOverview(): Promise<IndexerOpsOverview> {
    if (!this.opsReporter) {
      throw new Error("Indexer ops endpoints require postgres repository mode");
    }

    return this.opsReporter.buildOpsOverview({
      generatedAt: new Date().toISOString(),
      thresholds: loadAlertThresholds()
    });
  }

  async replayEvm(command: {
    network: "ethereum" | "bsc" | "base";
    observationType?: "deposit" | "withdrawal" | "both";
    fromBlock?: number;
    toBlock?: number;
    rpcUrl?: string;
  }) {
    return this.applicationService.runEvmReplay(command);
  }

  async repairBacklog(command: {
    network: "ethereum" | "bsc" | "base";
    observationType?: "deposit" | "withdrawal" | "both";
    lookbackBlocks?: number;
    rpcUrl?: string;
  }) {
    return this.applicationService.repairEvmBacklog(command);
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadAlertThresholds() {
  return {
    maxPendingDeposits: parseNumber(process.env.INDEXER_ALERT_MAX_PENDING_DEPOSITS, 50),
    maxPendingWithdrawals: parseNumber(
      process.env.INDEXER_ALERT_MAX_PENDING_WITHDRAWALS,
      50
    ),
    maxOldestPendingDepositAgeSeconds: parseNumber(
      process.env.INDEXER_ALERT_MAX_OLDEST_PENDING_DEPOSIT_AGE_SECONDS,
      600
    ),
    maxOldestPendingWithdrawalAgeSeconds: parseNumber(
      process.env.INDEXER_ALERT_MAX_OLDEST_PENDING_WITHDRAWAL_AGE_SECONDS,
      600
    ),
    maxScanLagBlocks: parseNumber(process.env.INDEXER_ALERT_MAX_SCAN_LAG_BLOCKS, 100),
    maxStaleCursorAgeSeconds: parseNumber(
      process.env.INDEXER_ALERT_MAX_STALE_CURSOR_AGE_SECONDS,
      900
    ),
    maxReorgCursors: parseNumber(process.env.INDEXER_ALERT_MAX_REORG_CURSORS, 0)
  };
}
