import assert from "node:assert/strict";
import test from "node:test";

import { OpsConsoleApplicationService } from "../application/ops-console-application-service.js";
import { InMemoryOpsActionAuditRepository } from "../infrastructure/in-memory-ops-action-audit-repository.js";
import type {
  OpsAlertSinkClient,
  OpsCustodyClient,
  OpsIdentityClient,
  OpsIndexerClient,
  OpsLedgerClient,
  OpsOrderClient,
  OpsSessionInfo,
  OpsSettlementClient,
  OpsWalletClient
} from "../domain/clients.js";

function createWalletClient(): OpsWalletClient {
  return {
    async listDeposits() {
      return {
        items: [
          {
            depositId: "dep-1",
            userId: "user-1",
            ledgerAccountId: "acct-1",
            assetCode: "ETH",
            amount: "1.25",
            network: "ethereum",
            txHash: "0xdep",
            status: "credited",
            createdAt: "2026-03-08T05:10:00.000Z"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async listWithdrawalReviewQueue() {
      return {
        items: [
          {
            withdrawalId: "wd-1",
            userId: "user-1",
            ledgerAccountId: "acct-1",
            assetCode: "ETH",
            amount: "0.2",
            txHash: "0xwd",
            status: "requested",
            reviewStatus: "pending"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async listWithdrawals() {
      return {
        items: [
          {
            withdrawalId: "wd-1",
            userId: "user-1",
            ledgerAccountId: "acct-1",
            assetCode: "ETH",
            amount: "0.2",
            txHash: "0xwd",
            status: "broadcasting",
            reviewStatus: "approved",
            custodyRequestId: "custody-1"
          },
          {
            withdrawalId: "wd-2",
            userId: "user-1",
            ledgerAccountId: "acct-1",
            assetCode: "USDT",
            amount: "15",
            txHash: "0xwd2",
            status: "confirmed",
            reviewStatus: "approved"
          }
        ],
        total: 2,
        limit: 20,
        offset: 0
      };
    },
    async getWithdrawal(withdrawalId) {
      if (withdrawalId === "wd-1") {
        return {
          withdrawalId,
          userId: "user-1",
          ledgerAccountId: "acct-1",
          assetCode: "ETH",
          amount: "0.2",
          txHash: "0xwd",
          status: "broadcasting",
          reviewStatus: "approved",
          custodyRequestId: "custody-1"
        };
      }

      return {
        withdrawalId,
        userId: "user-1",
        ledgerAccountId: "acct-1",
        assetCode: "USDT",
        amount: "15",
        txHash: "0xwd2",
        status: "broadcasted",
        custodyRequestId: "custody-1"
      };
    },
    async approveWithdrawal(command) {
      if (command.withdrawalId === "wd-fail") {
        const error = new Error("approval failed");
        error.name = "WITHDRAWAL_APPROVE_FAILED";
        throw error;
      }

      return {
        withdrawalId: command.withdrawalId,
        status: "approved"
      };
    },
    async rejectWithdrawal(command) {
      return {
        withdrawalId: command.withdrawalId,
        status: "rejected"
      };
    },
    async listWithdrawalAuditLogs(withdrawalId) {
      return {
        items: [
          {
            auditLogId: "audit-1",
            withdrawalId,
            action: "approved",
            operatorId: "ops-user"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async searchWithdrawalAuditLogs() {
      return {
        items: [
          {
            auditLogId: "audit-1",
            withdrawalId: "wd-1",
            action: "approved"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async listWithdrawalAddressBook() {
      return {
        items: [],
        total: 0,
        limit: 20,
        offset: 0
      };
    },
    async whitelistWithdrawalAddress(addressBookId) {
      return {
        addressBookId,
        isWhitelisted: true
      };
    },
    async unwhitelistWithdrawalAddress(addressBookId) {
      return {
        addressBookId,
        isWhitelisted: false
      };
    },
    async listNotifications() {
      return {
        items: [
          {
            notificationId: "notif-1",
            userId: "user-1",
            withdrawalId: "wd-1",
            eventType: "withdrawal.updated",
            status: "pending"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async deliverNotifications() {
      return {
        deliveredCount: 1
      };
    },
    async reconcileStaleWithdrawals() {
      return {
        rejectedCount: 1
      };
    }
  };
}

function createCustodyClient(): OpsCustodyClient {
  return {
    async getProviderHealth() {
      return [
        {
          providerName: "mock-custody",
          network: "ethereum",
          healthStatus: "healthy"
        }
      ];
    },
    async runProviderHealthChecks() {
      return {
        checkedCount: 1,
        healthyCount: 1
      };
    },
    async getOpsOverview() {
      return {
        status: "ok",
        openCircuitCount: 0
      };
    },
    async getTransfer(custodyTransferId) {
      return {
        custodyTransferId,
        providerName: "mock-custody",
        txHash: "0xwd",
        status: "confirmed"
      };
    }
  };
}

function createIdentityClient(): OpsIdentityClient {
  return {
    async login() {
      return {
        sessionId: "session-1",
        token: "token-1",
        userId: "ops-user",
        email: "ops@example.com",
        roles: ["ops_admin"],
        permissions: ["ops.dashboard.read"],
        createdAt: "2026-03-08T05:00:00.000Z",
        expiresAt: "2026-03-08T17:00:00.000Z",
        lastSeenAt: "2026-03-08T05:00:00.000Z",
        active: true
      };
    },
    async getCurrentSession() {
      return {
        sessionId: "session-1",
        userId: "ops-user",
        email: "ops@example.com",
        roles: ["ops_admin"],
        permissions: ["ops.dashboard.read"],
        createdAt: "2026-03-08T05:00:00.000Z",
        expiresAt: "2026-03-08T17:00:00.000Z",
        lastSeenAt: "2026-03-08T05:01:00.000Z",
        active: true,
        status: "active"
      };
    },
    async logout() {
      return {
        revoked: true,
        revokedAt: "2026-03-08T06:00:00.000Z"
      };
    },
    async listUsers() {
      return {
        items: [
          {
            userId: "user-1",
            email: "user@example.com",
            status: "active",
            userType: "customer"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async freezeUser(command) {
      return {
        userId: command.userId,
        status: "suspended"
      };
    },
    async unfreezeUser(userId) {
      return {
        userId,
        status: "active"
      };
    },
    async getKycProfile(userId) {
      return { userId, tier: "unverified", events: [] };
    },
    async listKycRequests() {
      return {
        items: [{ requestId: "kyc-1", userId: "user-1", requestedTier: "L1", status: "pending" }],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async approveKycRequest(command) {
      return {
        requestId: command.requestId,
        status: "approved",
        approvedTier: command.tier ?? "L1",
        reviewedBy: command.reviewedBy
      };
    },
    async rejectKycRequest(command) {
      return { requestId: command.requestId, status: "rejected", reviewedBy: command.reviewedBy };
    },
    async setKycTier(command) {
      return { userId: command.userId, tier: command.tier, events: [] };
    }
  };
}

function createLedgerClient(): OpsLedgerClient {
  return {
    async listBalances() {
      return {
        items: [
          {
            userId: "user-1",
            accountId: "acct-1",
            assetCode: "USDT",
            available: "100",
            locked: "5"
          },
          {
            userId: "user-1",
            accountId: "acct-1",
            assetCode: "ETH",
            available: "4.8",
            locked: "0.2"
          }
        ],
        total: 2,
        limit: 20,
        offset: 0
      };
    },
    async getReconciliationReport() {
      return {
        scannedCount: 5,
        mismatchCount: 1,
        items: [
          {
            accountId: "acct-1",
            assetCode: "USDT",
            mismatchReasons: ["available_mismatch"]
          }
        ]
      };
    },
    async getReplayReport() {
      return {
        accountId: "acct-1",
        assetCode: "USDT",
        mismatch: false,
        steps: []
      };
    },
    async getOpsOverview() {
      return {
        status: "alert",
        alerts: ["pending_outbox=2 exceeds threshold 0"]
      };
    },
    async drainOutbox() {
      return {
        publishedCount: 2
      };
    }
  };
}

function createIndexerClient(): OpsIndexerClient {
  return {
    async getOpsOverview() {
      return {
        status: "ok",
        alerts: []
      };
    },
    async replay() {
      return {
        observationType: "both"
      };
    },
    async repairBacklog() {
      return {
        lookbackBlocks: 50
      };
    },
    async listPendingDeposits() {
      return {
        items: [
          {
            observationId: "obs-1",
            userId: "user-1",
            ledgerAccountId: "acct-1",
            network: "ethereum",
            assetCode: "ETH",
            txHash: "0xdep",
            status: "pending_confirmations"
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      };
    },
    async replayPendingDeposit(command) {
      if (command.observationId === "obs-fail") {
        const error = new Error("replay failed");
        error.name = "INDEXER_REPLAY_FAILED";
        throw error;
      }

      return {
        status: "credited"
      };
    },
    async closePendingDeposit() {
      return {
        status: "closed"
      };
    }
  };
}

function createOrderClient(): OpsOrderClient {
  return {
    async listSpotOrders() {
      return [
        {
          orderId: "order-1",
          userId: "user-1",
          accountId: "acct-1",
          market: "BTC-USDT",
          side: "buy",
          status: "filled",
          filledQuantity: "0.1"
        }
      ];
    },
    async listSpotTrades() {
      return [
        {
          tradeId: "trade-1",
          orderId: "order-1",
          buyerOrderId: "order-1",
          userId: "user-1",
          accountId: "acct-1",
          buyerUserId: "user-1",
          buyerAccountId: "acct-1",
          market: "BTC-USDT",
          price: "40000",
          quantity: "0.1",
          settlementId: "settlement-1",
          executionSequence: 12,
          replayCursor: "BTC-USDT:12"
        }
      ];
    },
    async getTradeEventBusReport() {
      return {
        publisher: {
          mode: "redis",
          enabled: true
        },
        stream: {
          maxLen: 100,
          retentionMs: 600000,
          archive: {
            enabled: true,
            heads: [
              {
                market: "BTC-USDT",
                streamLength: 20,
                latestArchivedAt: "2026-03-08T07:30:00.000Z",
                latestSourceStreamEntryId: "1741417200000-10"
              }
            ]
          },
          heads: [
            {
              market: "BTC-USDT",
              streamLength: 100,
              replayWindowMs: 600000,
              oldestExecutionSequence: 1,
              oldestStreamEntryId: "1741417000000-1",
              latestExecutionSequence: 12,
              latestReplayCursor: "BTC-USDT:12",
              latestStreamEntryId: "1741417500000-12"
            }
          ]
        },
        operator: {
          lagSlo: {
            warning: 2,
            critical: 5
          }
        },
        versionGate: {
          supportedProtocolVersions: ["v2"]
        }
      };
    },
    async listTradeEventStreamEntries() {
      return [
        {
          streamEntryId: "1741417500000-12",
          market: "BTC-USDT",
          executionSequence: 12,
          replayCursor: "BTC-USDT:12",
          publishedAt: "2026-03-08T07:00:00.000Z"
        }
      ];
    },
    async replayTradeEventStream(command) {
      return {
        market: command.market,
        replayedCount: command.limit ?? 1,
        publishToChannel: command.publishToChannel ?? true
      };
    },
    async trimTradeEventStream(command) {
      return {
        strategy: command.strategy ?? "auto",
        dryRun: command.dryRun ?? false,
        trims: [
          {
            market: command.market ?? "BTC-USDT",
            streamKey: "web3-cex:trade-events:btc-usdt",
            beforeLength: 100,
            afterLength: 80,
            trimmedCount: 20
          }
        ]
      };
    },
    async maintainTradeEventStream(command) {
      return {
        dryRun: command.dryRun ?? false,
        force: command.force ?? false,
        markets: [
          {
            market: command.market ?? "BTC-USDT",
            reason: "trimmed",
            archive: {
              enabled: true,
              archivedCount: 20,
              archiveStreamKey: "web3-cex:trade-events:archive:btc-usdt"
            },
            trim: {
              trims: [
                {
                  trimmedCount: 20
                }
              ]
            }
          }
        ]
      };
    },
    async getTradeOpsOverview(query) {
      return {
        market: query.market,
        status: "ok",
        anomalyCount: 0
      };
    },
    async getTradeOpsAnomalies() {
      return [];
    },
    async replayEngineBook(query) {
      return {
        market: query.market,
        replayedOrderCount: 1,
        replayedOrderIds: ["order-1"]
      };
    },
    async listRecoveryJobs() {
      return [
        {
          jobId: "job-1",
          orderId: "order-1",
          market: "BTC-USDT",
          status: "pending",
          attemptCount: 1
        }
      ];
    },
    async getRecoveryMetrics() {
      return {
        totalJobs: 3,
        deadLetteredJobs: 1,
        averageDurationMs: 125
      };
    },
    async getRecoveryGovernanceReport() {
      return {
        activeWorkers: [
          {
            workerId: "order-worker-1",
            leasedJobs: 1
          }
        ]
      };
    },
    async getDeadLetterReport() {
      return {
        totalJobs: 1,
        entries: [
          {
            market: "BTC-USDT",
            jobCount: 1
          }
        ],
        templates: [
          {
            templateId: "dead-letter:all"
          }
        ]
      };
    },
    async listAutomationExecutions() {
      return [
        {
          executionId: "order-auto-1",
          executionType: "recovery_cycle",
          status: "succeeded"
        }
      ];
    },
    async listDeadLetterJobs() {
      return [
        {
          jobId: "job-dead-1",
          orderId: "order-9",
          market: "BTC-USDT",
          status: "failed",
          attemptCount: 20,
          deadLetteredAt: "2026-03-08T06:10:00.000Z"
        }
      ];
    },
    async processRecoveryJobs(command) {
      return {
        processedCount: command.limit ?? 1,
        completedCount: 1,
        failedCount: 0,
        jobIds: ["job-1"]
      };
    },
    async recoverJob(jobId) {
      return {
        jobId,
        status: "completed"
      };
    },
    async requeueDeadLetterJob(jobId) {
      return {
        jobId,
        status: "pending"
      };
    },
    async batchRequeueDeadLetterJobs(command) {
      return {
        requeuedCount: command.limit ?? 1,
        jobIds: ["job-dead-1"]
      };
    }
  };
}

function createSettlementClient(): OpsSettlementClient {
  return {
    async listTradeSettlements() {
      return [
        {
          settlementId: "settlement-1",
          tradeId: "trade-1",
          buyerOrderId: "order-1",
          buyerUserId: "user-1",
          buyerAccountId: "acct-1",
          market: "BTC-USDT",
          status: "settled",
          quantity: "0.1",
          quoteAmount: "4000",
          feeAmount: "4"
        }
      ];
    },
    async getTradeSettlementReport() {
      return {
        generatedAt: "2026-03-08T06:30:00.000Z",
        totals: {
          settlementCount: 1,
          settledCount: 1,
          pendingRecoveryCount: 0,
          failedCount: 0,
          quantity: "0.1",
          quoteAmount: "4000",
          feeAmount: "4"
        },
        markets: [
          {
            market: "BTC-USDT",
            settlementCount: 1,
            settledCount: 1,
            pendingRecoveryCount: 0,
            failedCount: 0,
            quantity: "0.1",
            quoteAmount: "4000",
            feeAmount: "4"
          }
        ]
      };
    },
    async listTradeSettlementRecoveryJobs() {
      return [
        {
          jobId: "settlement-job-1",
          tradeId: "trade-1",
          market: "BTC-USDT",
          status: "pending",
          attemptCount: 1
        }
      ];
    },
    async getTradeEventBusReport() {
      return {
        versionGate: {
          supportedProtocolVersions: ["v2"]
        },
        checkpoints: [
          {
            consumerId: "trade-settlement",
            market: "BTC-USDT",
            lastExecutionSequence: 10,
            lastReplayCursor: "BTC-USDT:10",
            updatedAt: "2026-03-08T07:00:00.000Z"
          }
        ]
      };
    },
    async listTradeEventConsumerCheckpoints() {
      return [
        {
          consumerId: "trade-settlement",
          market: "BTC-USDT",
          lastExecutionSequence: 10,
          lastReplayCursor: "BTC-USDT:10",
          lastStreamEntryId: "1741417500000-10",
          updatedAt: "2026-03-08T07:00:00.000Z"
        }
      ];
    },
    async processTradeEventSubscriptionCycle(command) {
      return {
        market: command.market ?? "BTC-USDT",
        processedCount: command.limit ?? 1,
        appliedCount: 1,
        duplicateCount: 0
      };
    },
    async getTradeSettlementRecoveryGovernanceReport() {
      return {
        activeWorkers: [
          {
            workerId: "settlement-worker-1",
            leasedJobs: 1
          }
        ]
      };
    },
    async listAutomationExecutions() {
      return [
        {
          executionId: "settlement-auto-1",
          executionType: "recovery_cycle",
          status: "partial"
        }
      ];
    },
    async processTradeSettlementRecoveryJobs(command) {
      return {
        processedCount: command.limit ?? 1,
        completedCount: 1,
        failedCount: 0,
        tradeIds: ["trade-1"]
      };
    },
    async recoverTradeSettlement(tradeId) {
      return {
        tradeId,
        status: "settled"
      };
    }
  };
}

function createAlertSinkClient(): OpsAlertSinkClient {
  return {
    async listTradeRuntimeAlertSinks() {
      return [
        {
          sinkId: "webhook-primary",
          name: "Primary Webhook",
          url: "https://alerts.example.com/trade-runtime",
          enabled: true,
          deliveryMode: "slack_webhook",
          route: "default"
        }
      ];
    },
    async deliverTradeRuntimeAlerts(command) {
      return [
        {
          sinkId: command.sinkId ?? "webhook-primary",
          market: command.market,
          ok: true
        }
      ];
    }
  };
}

function createOpsSession(): OpsSessionInfo {
  return {
    sessionId: "session-1",
    userId: "ops-user",
    email: "ops@example.com",
    displayName: "Ops User",
    roles: ["ops_admin"],
    permissions: [
      "ops.dashboard.read",
      "ops.users.freeze",
      "ops.withdrawals.review",
      "ops.withdrawals.batch_review",
      "ops.ledger.execute",
      "ops.notifications.manage",
      "ops.indexer.execute",
      "ops.indexer.pending.manage",
      "ops.audit.read",
      "ops.assets.read",
      "ops.alerts.read",
      "ops.alerts.manage"
    ],
    createdAt: "2026-03-08T05:00:00.000Z",
    expiresAt: "2026-03-08T17:00:00.000Z",
    lastSeenAt: "2026-03-08T05:01:00.000Z",
    active: true,
    status: "active"
  };
}

function createService(now?: () => Date) {
  let auditCounter = 0;
  return new OpsConsoleApplicationService(
    createWalletClient(),
    createCustodyClient(),
    createIdentityClient(),
    createLedgerClient(),
    createIndexerClient(),
    createOrderClient(),
    createSettlementClient(),
    new InMemoryOpsActionAuditRepository(() => `audit-log-${++auditCounter}`),
    createAlertSinkClient(),
    now ? { now } : {}
  );
}

test("dashboard aggregates wallet review queue and custody runtime", async () => {
  const service = createService(() => new Date("2026-03-08T05:00:00.000Z"));

  const result = await service.getDashboard({
    network: "ethereum",
    reviewQueueLimit: 10,
    notificationsLimit: 10
  });

  assert.equal(result.generatedAt, "2026-03-08T05:00:00.000Z");
  assert.equal(result.withdrawalReviewQueue.total, 1);
  assert.equal(result.pendingNotifications.total, 1);
  assert.equal(result.custody.overview.status, "ok");
  assert.equal(result.custody.providerHealth[0]?.providerName, "mock-custody");
});

test("trade recovery jobs can be listed and processed with audit logs", async () => {
  const service = createService(() => new Date("2026-03-08T06:00:00.000Z"));
  const session = createOpsSession();

  const jobs = await service.listTradeRecoveryJobs({
    market: "BTC-USDT",
    status: "pending"
  });
  const processResult = await service.processTradeRecoveryJobs(session, {
    limit: 10
  });
  const recoverResult = await service.recoverTradeRecoveryJob(session, "job-1");
  const auditLogs = await service.listActionAuditLogs({
    action: "trading.recovery.process_pending"
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, "job-1");
  assert.equal(processResult.completedCount, 1);
  assert.equal(recoverResult.status, "completed");
  assert.equal(auditLogs.total, 1);
});

test("trade dead-letter jobs can be listed and requeued with audit logs", async () => {
  const service = createService(() => new Date("2026-03-08T06:20:00.000Z"));
  const session = createOpsSession();

  const [metrics, jobs] = await Promise.all([
    service.getTradeRecoveryMetrics(),
    service.listTradeDeadLetterJobs({
      market: "BTC-USDT",
      status: "failed"
    })
  ]);
  const batchResult = await service.batchRequeueTradeDeadLetterJobs(session, {
    market: "BTC-USDT",
    limit: 10
  });
  const requeueResult = await service.requeueTradeDeadLetterJob(session, "job-dead-1");
  const history = await service.listExecutionHistory({
    templateId: "order_dead_letter_batch_requeue"
  });

  assert.equal(metrics.deadLetteredJobs, 1);
  assert.equal(jobs[0]?.jobId, "job-dead-1");
  assert.equal(batchResult.requeuedCount, 10);
  assert.equal(requeueResult.status, "pending");
  assert.equal(history.total, 1);
});

test("trade settlement report aggregates by market", async () => {
  const service = createService(() => new Date("2026-03-08T06:30:00.000Z"));

  const report = await service.getTradeSettlementReport({
    market: "BTC-USDT"
  }) as {
    totals: { settlementCount: number };
    markets: Array<{
      market: string;
      quantity: string;
      quoteAmount: string;
      feeAmount: string;
    }>;
  };

  assert.equal(report.totals.settlementCount, 1);
  assert.equal(report.markets[0]?.market, "BTC-USDT");
  assert.equal(report.markets[0]?.quantity, "0.1");
  assert.equal(report.markets[0]?.quoteAmount, "4000");
  assert.equal(report.markets[0]?.feeAmount, "4");
});

test("trade settlement recovery jobs can be listed and processed with audit logs", async () => {
  const service = createService(() => new Date("2026-03-08T06:45:00.000Z"));
  const session = createOpsSession();

  const jobs = await service.listTradeSettlementRecoveryJobs({
    market: "BTC-USDT",
    status: "pending"
  });
  const processResult = await service.processTradeSettlementRecoveryJobs(session, {
    limit: 10
  });
  const recoverResult = await service.recoverTradeSettlement(session, "trade-1");
  const auditLogs = await service.listActionAuditLogs({
    action: "settlement.recovery.process_pending"
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.tradeId, "trade-1");
  assert.equal(processResult.completedCount, 1);
  assert.equal(recoverResult.status, "settled");
  assert.equal(auditLogs.total, 1);
});

test("execution templates can be listed and executed", async () => {
  const service = createService(() => new Date("2026-03-08T07:00:00.000Z"));
  const session = createOpsSession();

  const templates = await service.listExecutionTemplates();
  const result = (await service.executeExecutionTemplate(
    session,
    "settlement_recovery_batch_process",
    {
      limit: 5
    }
  )) as Record<string, unknown>;
  const history = await service.listExecutionHistory({
    templateId: "settlement_recovery_batch_process"
  });

  assert.equal(templates.length >= 4, true);
  assert.equal(result.completedCount, 1);
  assert.equal(history.total, 1);
});

test("trade runtime report aggregates governance, dead-letter, and automation history", async () => {
  const service = createService(() => new Date("2026-03-08T07:05:00.000Z"));

  const report = (await service.getTradeRuntimeReport({
    market: "BTC-USDT",
    historyLimit: 5
  })) as unknown as {
    market: string;
    order: {
      trades: Array<{ executionSequence?: number }>;
      recoveryGovernance: { activeWorkers: Array<{ workerId?: string }> };
      deadLetterReport: { totalJobs: number };
    };
    settlement: {
      eventBus: { checkpoints: Array<{ lastExecutionSequence?: number }> };
      recoveryGovernance: { activeWorkers: Array<{ workerId?: string }> };
    };
    eventBus: { latestExecutionSequence?: number };
    schedules: unknown[];
    templates: unknown[];
  };

  assert.equal(report.market, "BTC-USDT");
  assert.equal(report.order.trades[0]?.executionSequence, 12);
  assert.equal(report.order.recoveryGovernance.activeWorkers[0]?.workerId, "order-worker-1");
  assert.equal(report.order.deadLetterReport.totalJobs, 1);
  assert.equal(report.settlement.eventBus.checkpoints[0]?.lastExecutionSequence, 10);
  assert.equal(
    report.settlement.recoveryGovernance.activeWorkers[0]?.workerId,
    "settlement-worker-1"
  );
  assert.equal(report.eventBus.latestExecutionSequence, 12);
  assert.equal(report.schedules.length >= 1, true);
  assert.equal(report.templates.length >= 4, true);
});

test("trade domain recovery sweep template orchestrates order and settlement recovery", async () => {
  const service = createService(() => new Date("2026-03-08T07:10:00.000Z"));
  const session = createOpsSession();

  const result = (await service.executeExecutionTemplate(
    session,
    "trade_domain_recovery_sweep",
    {
      market: "BTC-USDT",
      orderRecoveryLimit: 2,
      settlementRecoveryLimit: 3,
      deadLetterRequeueLimit: 1
    }
  )) as unknown as {
    market: string;
    orderRecovery: { completedCount: number };
    settlementRecovery: { completedCount: number };
    deadLetterRequeue: { requeuedCount: number };
  };

  assert.equal(result.market, "BTC-USDT");
  assert.equal(result.orderRecovery.completedCount, 1);
  assert.equal(result.settlementRecovery.completedCount, 1);
  assert.equal(result.deadLetterRequeue.requeuedCount, 1);
});

test("execution schedules can be listed and due schedules can be executed", async () => {
  const service = createService(() => new Date("2026-03-08T07:20:00.000Z"));
  const session = createOpsSession();

  const schedules = await service.listExecutionSchedules({
    market: "BTC-USDT",
    dueOnly: true
  });
  const result = await service.runDueExecutionSchedules(
    {
      scheduleId: "trade_domain_recovery_sweep:btc-usdt",
      force: true,
      limit: 5
    },
    session
  );

  assert.equal(schedules.length >= 1, true);
  assert.equal(schedules.some((item) => item.status === "due"), true);
  assert.equal(result.executedCount, 1);
  assert.equal(result.items[0]?.market, "BTC-USDT");
});

test("execution history diff compares consecutive sweep runs", async () => {
  const service = createService(
    (() => {
      let offset = 0;
      return () => new Date(Date.parse("2026-03-08T07:30:00.000Z") + offset++ * 60_000);
    })()
  );
  const session = createOpsSession();

  await service.executeExecutionTemplate(session, "trade_domain_recovery_sweep", {
    market: "BTC-USDT",
    orderRecoveryLimit: 2,
    settlementRecoveryLimit: 3,
    deadLetterRequeueLimit: 1
  });
  await service.executeExecutionTemplate(session, "trade_domain_recovery_sweep", {
    market: "BTC-USDT",
    orderRecoveryLimit: 2,
    settlementRecoveryLimit: 3,
    deadLetterRequeueLimit: 1
  });

  const diff = (await service.getExecutionHistoryDiff({
    templateId: "trade_domain_recovery_sweep",
    targetId: "BTC-USDT",
    limit: 5
  })) as {
    current?: { metrics?: Record<string, number> };
    previous?: { metrics?: Record<string, number> };
    delta: Record<string, number>;
  };

  assert.equal(diff.current?.metrics?.["orderRecovery.completedCount"], 1);
  assert.equal(diff.previous?.metrics?.["orderRecovery.completedCount"], 1);
  assert.equal(diff.delta["orderRecovery.completedCount"], 0);
});

test("trade runtime alert export surfaces lag and schedule issues", async () => {
  const service = createService(() => new Date("2026-03-08T07:40:00.000Z"));

  const result = (await service.exportTradeRuntimeAlerts({
    market: "BTC-USDT",
    historyLimit: 5
  })) as {
    status: string;
    alerts: Array<{ code?: string }>;
  };

  assert.equal(result.status, "alert");
  assert.equal(
    result.alerts.some((item) => item.code === "TRADE_EVENT_CONSUMER_LAG"),
    true
  );
  assert.equal(
    result.alerts.some((item) => item.code === "ORDER_DEAD_LETTER_BACKLOG"),
    true
  );
});

test("trade runtime drilldown exposes stream entries, checkpoint lag, and sinks", async () => {
  const service = createService(() => new Date("2026-03-08T07:45:00.000Z"));

  const result = (await service.getTradeRuntimeDrilldown({
    market: "BTC-USDT",
    historyLimit: 5,
    streamLimit: 5,
    checkpointLimit: 5
  })) as {
    eventBus: {
      latestArchiveHead?: { latestSourceStreamEntryId?: string };
      checkpoints: Array<{ executionSequenceLag?: number; streamUpToDate?: boolean }>;
      recentStreamEntries: Array<{ streamEntryId?: string }>;
    };
    alerting: {
      sinks: Array<{ sinkId?: string }>;
    };
  };

  assert.equal(result.eventBus.checkpoints[0]?.executionSequenceLag, 2);
  assert.equal(result.eventBus.checkpoints[0]?.streamUpToDate, false);
  assert.equal(result.eventBus.latestArchiveHead?.latestSourceStreamEntryId, "1741417200000-10");
  assert.equal(result.eventBus.recentStreamEntries[0]?.streamEntryId, "1741417500000-12");
  assert.equal(result.alerting.sinks[0]?.sinkId, "webhook-primary");
});

test("trade event replay can cascade settlement processing and audit the operator action", async () => {
  const service = createService(() => new Date("2026-03-08T07:46:00.000Z"));
  const session = createOpsSession();

  const result = (await service.replayTradeEventStream(session, {
    market: "BTC-USDT",
    limit: 2,
    processSettlement: true
  })) as {
    replay: { replayedCount: number };
    settlementProcessing?: { appliedCount: number };
  };
  const auditLogs = await service.listActionAuditLogs({
    action: "trading.event_bus.stream.replay"
  });

  assert.equal(result.replay.replayedCount, 2);
  assert.equal(result.settlementProcessing?.appliedCount, 1);
  assert.equal(auditLogs.total, 1);
});

test("trade event stream trim delegates to order service and audits the operator action", async () => {
  const service = createService(() => new Date("2026-03-08T07:46:30.000Z"));
  const session = createOpsSession();

  const result = (await service.trimTradeEventStream(session, {
    market: "BTC-USDT",
    strategy: "auto"
  })) as {
    trims: Array<{ trimmedCount?: number }>;
  };
  const auditLogs = await service.listActionAuditLogs({
    action: "trading.event_bus.stream.trim"
  });

  assert.equal(result.trims[0]?.trimmedCount, 20);
  assert.equal(auditLogs.total, 1);
});

test("trade event stream maintenance delegates archive and trim to order service", async () => {
  const service = createService(() => new Date("2026-03-08T07:46:40.000Z"));
  const session = createOpsSession();

  const result = (await service.maintainTradeEventStream(session, {
    market: "BTC-USDT"
  })) as {
    markets: Array<{
      archive?: { archivedCount?: number };
      trim?: { trims?: Array<{ trimmedCount?: number }> };
    }>;
  };
  const auditLogs = await service.listActionAuditLogs({
    action: "trading.event_bus.stream.maintenance"
  });

  assert.equal(result.markets[0]?.archive?.archivedCount, 20);
  assert.equal(result.markets[0]?.trim?.trims?.[0]?.trimmedCount, 20);
  assert.equal(auditLogs.total, 1);
});

test("trade event bus self-heal replays lagged entries, trims retention pressure, and delivers alerts", async () => {
  const service = createService(() => new Date("2026-03-08T07:46:45.000Z"));
  const session = createOpsSession();

  const result = (await service.selfHealTradeEventBus(session, {
    market: "BTC-USDT",
    replayLimit: 5,
    overlapCount: 2,
    deliverAlerts: true,
    trim: true
  })) as {
    lag: { current?: number; threshold?: number };
    replay: { replayedCount?: number };
    settlementProcessing: { appliedCount?: number };
    maintenance: { markets?: Array<{ trim?: { trims?: Array<{ trimmedCount?: number }> } }> };
    alerting: { deliveredCount?: number };
  };
  const auditLogs = await service.listActionAuditLogs({
    action: "trading.event_bus.self_heal"
  });

  assert.equal(result.lag.current, 2);
  assert.equal(result.lag.threshold, 2);
  assert.equal(result.replay.replayedCount, 5);
  assert.equal(result.settlementProcessing.appliedCount, 1);
  assert.equal(result.maintenance.markets?.[0]?.trim?.trims?.[0]?.trimmedCount, 20);
  assert.equal(result.alerting.deliveredCount, 1);
  assert.equal(auditLogs.total, 1);
});

test("trade runtime alert delivery exports payloads to configured sinks", async () => {
  const service = createService(() => new Date("2026-03-08T07:47:00.000Z"));
  const session = createOpsSession();

  const result = (await service.deliverTradeRuntimeAlerts(session, {
    market: "BTC-USDT",
    historyLimit: 5,
    sinkId: "webhook-primary"
  })) as {
    deliveredCount: number;
    deliveries: Array<{ sinkId?: string; ok?: boolean }>;
  };

  assert.equal(result.deliveredCount, 1);
  assert.equal(result.deliveries[0]?.sinkId, "webhook-primary");
  assert.equal(result.deliveries[0]?.ok, true);
});

test("trade runtime alert export escalates repeated warning windows to escalation route", async () => {
  const timestamps = [
    "2026-03-08T07:50:00.000Z",
    "2026-03-08T07:55:00.000Z",
    "2026-03-08T08:00:00.000Z",
    "2026-03-08T08:05:00.000Z",
    "2026-03-08T08:10:00.000Z",
    "2026-03-08T08:15:00.000Z"
  ];
  let index = 0;
  const service = createService(
    () => new Date(timestamps[Math.min(index++, timestamps.length - 1)] ?? timestamps[0]!)
  );
  const session = createOpsSession();

  await service.deliverTradeRuntimeAlerts(session, {
    market: "BTC-USDT",
    historyLimit: 5,
    sinkId: "webhook-primary"
  });
  await service.deliverTradeRuntimeAlerts(session, {
    market: "BTC-USDT",
    historyLimit: 5,
    sinkId: "webhook-primary"
  });
  const result = (await service.exportTradeRuntimeAlerts({
    market: "BTC-USDT",
    historyLimit: 5
  })) as {
    routing: {
      route?: string;
      reason?: string;
      consecutiveAlertWindows?: number;
    };
  };

  assert.equal(result.routing.route, "escalation");
  assert.equal(result.routing.reason, "repeated_alert_window");
  assert.equal(result.routing.consecutiveAlertWindows, 3);
});

test("withdrawal detail attaches custody transfer when custody request exists", async () => {
  const service = createService();

  const result = await service.getWithdrawalDetail("wd-1", {});

  assert.equal(result.withdrawal.withdrawalId, "wd-1");
  assert.equal(result.auditLogs.total, 1);
  assert.equal(result.custodyTransfer?.custodyTransferId, "custody-1");
});

test("search endpoints delegate to identity and ledger clients", async () => {
  const service = createService();

  const [users, balances, deposits, withdrawals] = await Promise.all([
    service.listUsers({}),
    service.listBalances({}),
    service.listDeposits({}),
    service.listWithdrawals({})
  ]);

  assert.equal(users.total, 1);
  assert.equal(balances.items[0]?.assetCode, "USDT");
  assert.equal(deposits.items[0]?.depositId, "dep-1");
  assert.equal(withdrawals.items[0]?.withdrawalId, "wd-1");
});

test("spot trading search and replay delegate to order and settlement clients", async () => {
  const service = createService();
  const session = createOpsSession();

  const [orders, trades, settlements, overview, anomalies, replay] = await Promise.all([
    service.listSpotOrders({ market: "BTC-USDT" }),
    service.listSpotTrades({ market: "BTC-USDT" }),
    service.listTradeSettlements({ market: "BTC-USDT" }),
    service.getTradeOpsOverview({ market: "BTC-USDT" }),
    service.getTradeOpsAnomalies({ market: "BTC-USDT" }),
    service.replayTradeEngineBook(session, { market: "BTC-USDT" })
  ]);

  assert.equal(orders[0]?.orderId, "order-1");
  assert.equal(trades[0]?.tradeId, "trade-1");
  assert.equal(settlements[0]?.settlementId, "settlement-1");
  assert.equal(overview.market, "BTC-USDT");
  assert.equal(anomalies.length, 0);
  assert.equal(replay.replayedOrderCount, 1);

  const auditLogs = await service.listActionAuditLogs({
    action: "trading.engine.replay"
  });
  assert.equal(auditLogs.total, 1);
});

test("audited operational actions persist action logs", async () => {
  const service = createService();
  const session = createOpsSession();

  const [frozen, drained, delivered, repaired] = await Promise.all([
    service.freezeUser(session, {
      userId: "user-1",
      reason: "ops review"
    }),
    service.drainLedgerOutbox(session, {
      requeueDeadLetter: true,
      maxCycles: 2
    }),
    service.deliverNotifications(session, {
      limit: 10
    }),
    service.repairIndexerBacklog(session, {
      network: "ethereum",
      observationType: "both",
      lookbackBlocks: 50
    })
  ]);

  assert.equal(frozen.status, "suspended");
  assert.equal(drained.publishedCount, 2);
  assert.equal(delivered.deliveredCount, 1);
  assert.equal(repaired.lookbackBlocks, 50);

  const auditLogs = await service.listActionAuditLogs({});
  assert.equal(auditLogs.total, 4);
  assert.equal(auditLogs.items.every((item) => item.status === "succeeded"), true);
});

test("KYC review and tier adjustments are audited with the operator", async () => {
  const service = createService();
  const session = createOpsSession();

  const pending = await service.listKycRequests({ status: "pending" });
  assert.equal(pending.total, 1);

  const approved = await service.approveKycRequest(session, {
    requestId: "kyc-1",
    reviewedBy: session.userId,
    tier: "L2",
    note: "demo"
  });
  assert.equal(approved.approvedTier, "L2");
  assert.equal(approved.reviewedBy, session.userId);

  await service.rejectKycRequest(session, { requestId: "kyc-2", reviewedBy: session.userId, note: "blurry" });
  const adjusted = await service.setUserKycTier(session, {
    userId: "user-1",
    tier: "L1",
    actorId: session.userId,
    reason: "risk"
  });
  assert.equal(adjusted.tier, "L1");

  const auditLogs = await service.listActionAuditLogs({});
  assert.deepEqual(
    auditLogs.items.map((item) => item.action).sort(),
    ["user.kyc.approve", "user.kyc.reject", "user.kyc.set_tier"]
  );
  assert.ok(auditLogs.items.every((item) => item.permission === "ops.users.manage"));
  assert.ok(auditLogs.items.every((item) => item.operatorUserId === session.userId));
});

test("alerts overview aggregates upstream and wallet signals", async () => {
  const service = createService(() => new Date("2026-03-08T06:00:00.000Z"));

  const result = await service.getAlertsOverview();

  assert.equal(result.generatedAt, "2026-03-08T06:00:00.000Z");
  assert.equal(result.status, "alert");
  assert.equal(result.sources.length, 4);
  assert.equal(result.sources[0]?.source, "ledger");
});

test("module navigation exposes every core service entry", async () => {
  const service = createService();

  const modules = await service.listModuleNavigation();

  assert.equal(modules.length >= 11, true);
  assert.equal(modules.some((item) => item.moduleId === "identity-service"), true);
  assert.equal(modules.some((item) => item.moduleId === "matching-engine"), true);
  assert.equal(modules.some((item) => item.moduleId === "market-data-service"), true);
});

test("business trace links withdrawal, ledger, custody, notifications and wallet audit", async () => {
  const service = createService(() => new Date("2026-03-08T08:20:00.000Z"));

  const result = (await service.getBusinessTrace({
    withdrawalId: "wd-1",
    limit: 10
  })) as {
    root: { kind?: string };
    inferred: { userId?: string; accountId?: string; txHash?: string };
    entities: {
      withdrawal?: { withdrawalId?: string };
      custodyTransfer?: { custodyTransferId?: string };
      balances: Array<{ accountId?: string }>;
      notifications: Array<{ withdrawalId?: string }>;
      withdrawalAuditLogs: Array<{ auditLogId?: string }>;
    };
    steps: Array<{ moduleId?: string }>;
  };

  assert.equal(result.root.kind, "withdrawal");
  assert.equal(result.inferred.userId, "user-1");
  assert.equal(result.inferred.accountId, "acct-1");
  assert.equal(result.inferred.txHash, "0xwd");
  assert.equal(result.entities.withdrawal?.withdrawalId, "wd-1");
  assert.equal(result.entities.custodyTransfer?.custodyTransferId, "custody-1");
  assert.equal(result.entities.balances[0]?.accountId, "acct-1");
  assert.equal(result.entities.notifications[0]?.withdrawalId, "wd-1");
  assert.equal(result.entities.withdrawalAuditLogs[0]?.auditLogId, "audit-1");
  assert.equal(result.steps.some((item) => item.moduleId === "wallet-service"), true);
  assert.equal(result.steps.some((item) => item.moduleId === "ledger-service"), true);
  assert.equal(result.steps.some((item) => item.moduleId === "custody-adapter"), true);
  assert.equal(result.steps.some((item) => item.moduleId === "api-gateway"), true);
});

test("business trace links order, trade, settlement and ledger projections", async () => {
  const service = createService(() => new Date("2026-03-08T08:25:00.000Z"));

  const result = (await service.getBusinessTrace({
    orderId: "order-1",
    limit: 10
  })) as {
    root: { kind?: string };
    inferred: { accountId?: string; market?: string };
    entities: {
      order?: { orderId?: string };
      trade?: { tradeId?: string };
      settlement?: { settlementId?: string };
      balances: Array<{ accountId?: string }>;
    };
    related: {
      orders: Array<{ orderId?: string }>;
      trades: Array<{ tradeId?: string }>;
      settlements: Array<{ settlementId?: string }>;
    };
    steps: Array<{ moduleId?: string }>;
  };

  assert.equal(result.root.kind, "order");
  assert.equal(result.inferred.accountId, "acct-1");
  assert.equal(result.inferred.market, "BTC-USDT");
  assert.equal(result.entities.order?.orderId, "order-1");
  assert.equal(result.entities.trade?.tradeId, "trade-1");
  assert.equal(result.entities.settlement?.settlementId, "settlement-1");
  assert.equal(result.entities.balances[0]?.accountId, "acct-1");
  assert.equal(result.related.orders[0]?.orderId, "order-1");
  assert.equal(result.related.trades[0]?.tradeId, "trade-1");
  assert.equal(result.related.settlements[0]?.settlementId, "settlement-1");
  assert.equal(result.steps.some((item) => item.moduleId === "order-service"), true);
  assert.equal(result.steps.some((item) => item.moduleId === "settlement-service"), true);
  assert.equal(result.steps.some((item) => item.moduleId === "ledger-service"), true);
});

test("audit search proxies wallet global audit query", async () => {
  const service = createService();

  const result = await service.searchWithdrawalAuditLogs({
    action: "approved",
    operatorId: "ops-user"
  });

  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.auditLogId, "audit-1");
});

test("batch approval records partial failures and batch summary", async () => {
  const service = createService();
  const session = createOpsSession();

  const result = await service.batchApproveWithdrawals(session, {
    withdrawalIds: ["wd-1", "wd-fail"],
    reviewedBy: session.userId,
    note: "batch approve"
  });

  assert.equal(result.totalCount, 2);
  assert.equal(result.succeededCount, 1);
  assert.equal(result.failedCount, 1);

  const auditLogs = await service.listActionAuditLogs({
    action: "withdrawal.approve"
  });
  assert.equal(auditLogs.total, 2);

  const batchLogs = await service.listActionAuditLogs({
    action: "withdrawal.batch_approve"
  });
  assert.equal(batchLogs.total, 1);
  assert.equal(batchLogs.items[0]?.status, "failed");
});

test("batch replay pending deposits groups successful and failed items", async () => {
  const service = createService();
  const session = createOpsSession();

  const result = await service.batchReplayIndexerPendingDeposits(session, {
    observationIds: ["obs-1", "obs-fail"],
    operatedBy: session.userId,
    note: "batch replay"
  });

  assert.equal(result.totalCount, 2);
  assert.equal(result.succeededCount, 1);
  assert.equal(result.failedCount, 1);

  const auditLogs = await service.listActionAuditLogs({
    action: "indexer.pending_deposit.batch_replay"
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.status, "failed");
});
