import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { AssetCode } from "@web3-cex/domain";
import type { Pool } from "pg";

import { LedgerAlertRemediator } from "../application/ledger-alert-remediator.js";
import { LedgerApplicationService } from "../application/ledger-application-service.js";
import type {
  LedgerAccountReplayReport,
  LedgerBalanceReconciliationReport,
  LedgerOpsOverview
} from "../application/ledger-ops.js";
import type {
  AccountStatement,
  AccountStatementQuery,
  BalanceLock,
  LedgerBalanceListItem,
  PagedResult,
  BalanceSnapshot,
  ConsumeBalanceCommand,
  CreateAccountCommand,
  LedgerAccount,
  LedgerEntryRecord,
  LedgerJournal,
  LedgerJournalSummary,
  ListBalancesQuery,
  ListEntriesQuery,
  ListJournalsQuery,
  PostJournalCommand
} from "../domain/types.js";
import type { FreezeBalanceCommand, ReleaseBalanceCommand } from "../domain/types.js";
import type { LedgerRepository } from "../domain/repository.js";
import { InMemoryLedgerRepository } from "../infrastructure/in-memory-ledger-repository.js";
import { KafkaLedgerOutboxTransport } from "../infrastructure/kafka-ledger-outbox-transport.js";
import { LedgerOpsReporter } from "../infrastructure/ledger-ops-reporter.js";
import { PostgresLedgerRepository } from "../infrastructure/postgres-ledger-repository.js";
import { createLedgerPool } from "../infrastructure/postgres.js";

@Injectable()
export class LedgerHttpService implements OnModuleDestroy {
  private readonly applicationService: LedgerApplicationService;
  private readonly repository: LedgerRepository;
  private readonly pool?: Pool;
  private readonly opsReporter?: LedgerOpsReporter;

  constructor() {
    const repositoryMode = process.env.LEDGER_REPOSITORY ?? "postgres";

    if (repositoryMode === "memory") {
      this.repository = new InMemoryLedgerRepository();
    } else {
      this.pool = createLedgerPool();
      this.repository = new PostgresLedgerRepository(this.pool, this.pool);
      this.opsReporter = new LedgerOpsReporter(this.pool);
    }

    this.applicationService = new LedgerApplicationService(this.repository);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /** Shared pool + ops reporter for the reconciliation job (absent with LEDGER_REPOSITORY=memory). */
  getOpsInfrastructure(): { pool?: Pool; reporter?: LedgerOpsReporter } {
    return { pool: this.pool, reporter: this.opsReporter };
  }

  async createAccount(command: CreateAccountCommand): Promise<LedgerAccount> {
    return this.applicationService.createAccount(command);
  }

  async getAccount(accountId: string): Promise<LedgerAccount | null> {
    return this.applicationService.getAccount(accountId);
  }

  async postJournal(command: PostJournalCommand): Promise<LedgerJournal> {
    return this.applicationService.postJournal(command);
  }

  async freezeBalance(command: FreezeBalanceCommand): Promise<BalanceLock> {
    return this.applicationService.freezeBalance(command);
  }

  async releaseBalance(command: ReleaseBalanceCommand): Promise<BalanceLock> {
    return this.applicationService.releaseBalance(command);
  }

  async consumeBalance(command: ConsumeBalanceCommand): Promise<BalanceLock> {
    return this.applicationService.consumeBalance(command);
  }

  async getBalance(accountId: string, assetCode: AssetCode): Promise<BalanceSnapshot> {
    return this.applicationService.getBalance(accountId, assetCode);
  }

  async getJournal(journalId: string): Promise<LedgerJournal | null> {
    return this.applicationService.getJournal(journalId);
  }

  async listJournals(query: ListJournalsQuery): Promise<LedgerJournalSummary[]> {
    return this.applicationService.listJournals(query);
  }

  async listBalances(query: ListBalancesQuery): Promise<PagedResult<LedgerBalanceListItem>> {
    return this.applicationService.listBalances(query);
  }

  async listEntries(query: ListEntriesQuery): Promise<LedgerEntryRecord[]> {
    return this.applicationService.listEntries(query);
  }

  async getAccountStatement(query: AccountStatementQuery): Promise<AccountStatement> {
    return this.applicationService.getAccountStatement(query);
  }

  async getReconciliationReport(params: {
    accountId?: string;
    assetCode?: AssetCode;
    includeMatched?: boolean;
  }): Promise<LedgerBalanceReconciliationReport> {
    return this.requireOpsReporter().reconcileBalances({
      ...params,
      generatedAt: new Date().toISOString()
    });
  }

  async getReplayReport(params: {
    accountId: string;
    assetCode: AssetCode;
  }): Promise<LedgerAccountReplayReport> {
    return this.requireOpsReporter().replayAccount({
      ...params,
      generatedAt: new Date().toISOString()
    });
  }

  async getOpsOverview(params: {
    staleLockMinutes?: number;
  }): Promise<LedgerOpsOverview> {
    const staleLockMinutes = params.staleLockMinutes ?? parseNumber(
      process.env.LEDGER_ALERT_STALE_LOCK_MINUTES,
      30
    );

    return this.requireOpsReporter().buildOpsOverview({
      generatedAt: new Date().toISOString(),
      staleLockMinutes,
      thresholds: {
        maxPendingOutbox: parseNumber(process.env.LEDGER_ALERT_MAX_PENDING_OUTBOX, 100),
        maxRetryingOutbox: parseNumber(process.env.LEDGER_ALERT_MAX_RETRYING_OUTBOX, 20),
        maxDeadLetteredOutbox: parseNumber(
          process.env.LEDGER_ALERT_MAX_DEAD_LETTERED_OUTBOX,
          0
        ),
        maxOldestPendingOutboxAgeSeconds: parseNumber(
          process.env.LEDGER_ALERT_MAX_OLDEST_PENDING_OUTBOX_AGE_SECONDS,
          300
        ),
        maxStaleLocks: parseNumber(process.env.LEDGER_ALERT_MAX_STALE_LOCKS, 0),
        maxBalanceMismatches: parseNumber(
          process.env.LEDGER_ALERT_MAX_BALANCE_MISMATCHES,
          0
        ),
        maxNegativeAvailableBalances: parseNumber(
          process.env.LEDGER_ALERT_MAX_NEGATIVE_AVAILABLE_BALANCES,
          0
        ),
        maxNegativeLockedBalances: parseNumber(
          process.env.LEDGER_ALERT_MAX_NEGATIVE_LOCKED_BALANCES,
          0
        )
      }
    });
  }

  async drainOutboxAlerts(params: {
    requeueDeadLetter?: boolean;
    maxCycles?: number;
  }): Promise<{
    requeuedCount: number;
    publishedCount: number;
    failedCount: number;
    deadLetteredCount: number;
    cycles: number;
  }> {
    if (!this.pool) {
      throw new Error("Ledger drain endpoint requires postgres repository mode");
    }

    const transport = new KafkaLedgerOutboxTransport({
      brokers: (process.env.KAFKA_BROKERS ?? "127.0.0.1:9092")
        .split(",")
        .map((broker) => broker.trim())
        .filter(Boolean),
      clientId: process.env.LEDGER_OUTBOX_CLIENT_ID ?? "ledger-outbox-publisher",
      topic: process.env.LEDGER_OUTBOX_TOPIC ?? "ledger.events",
      deadLetterTopic: process.env.LEDGER_OUTBOX_DEAD_LETTER_TOPIC ?? "dead-letter.events"
    });

    try {
      const remediator = new LedgerAlertRemediator(this.repository, transport, {
        batchSize: parseNumber(process.env.LEDGER_OUTBOX_BATCH_SIZE, 100),
        maxAttempts: parseNumber(process.env.LEDGER_OUTBOX_MAX_ATTEMPTS, 5),
        retryDelayMs: parseNumber(process.env.LEDGER_OUTBOX_RETRY_DELAY_MS, 5000)
      });

      return remediator.drainOutboxAlerts({
        requeueDeadLetter: params.requeueDeadLetter,
        maxCycles: params.maxCycles
      });
    } finally {
      await transport.disconnect();
    }
  }

  private requireOpsReporter(): LedgerOpsReporter {
    if (!this.opsReporter) {
      throw new Error("Ledger ops endpoints require postgres repository mode");
    }

    return this.opsReporter;
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
