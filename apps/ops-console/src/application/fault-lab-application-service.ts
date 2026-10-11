import { DEFAULT_SPOT_MARKET, listSpotMarkets } from "@web3-cex/domain";

import { OpsConsoleError } from "../domain/errors.js";
import type { OpsOrderClient, OpsSessionInfo } from "../domain/clients.js";
import { FAULT_LAB_AUDIT_PERMISSION, type OpsFaultLabClient } from "../domain/fault-lab.js";
import type { AuditedActionOptions } from "./ops-console-application-service.js";

type AuditedRunner = <T>(options: AuditedActionOptions, operation: () => Promise<T>) => Promise<T>;

// Experiments run on any configured market (config/markets.json).
const DEFAULT_LAB_MARKET = DEFAULT_SPOT_MARKET;
const LAB_MARKETS: string[] = listSpotMarkets({ includeDelisted: true });
const LAB_NETWORK = "ethereum";
const ENGINE_ANOMALY_TYPES = new Set(["engine_missing_open_order", "engine_orphan_order"]);

export type FaultLabSection =
  | { available: true; data: Record<string, unknown> }
  | { available: false; error: string };

export interface FaultLabActiveFault {
  experiment: "settlement" | "custody" | "chain" | "engine";
  summary: string;
  expiresAt?: string;
}

/**
 * Orchestrates the M3-2 fault lab for ops-console: one status view across all
 * experiments plus audited trigger / recover actions. Every injected fault
 * expires upstream on its own; `recoverAll` clears whatever is still active.
 */
export class FaultLabApplicationService {
  private readonly now: () => Date;

  constructor(
    private readonly labClient: OpsFaultLabClient,
    private readonly orderClient: Pick<OpsOrderClient, "getTradeOpsAnomalies" | "getTradeOpsOverview" | "replayEngineBook">,
    private readonly runAudited: AuditedRunner,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getStatus(query: { market?: string } = {}) {
    const market = requireMarket(query.market ?? DEFAULT_LAB_MARKET);
    const [settlement, custody, chain, anomalies, overview] = await Promise.all([
      section(() => this.labClient.getSettlementConsumerState()),
      section(() => this.labClient.getCustodyLabState(LAB_NETWORK)),
      section(() => this.labClient.getChainLabStatus()),
      section(async () => ({ items: await this.orderClient.getTradeOpsAnomalies({ market }) })),
      section(() => this.orderClient.getTradeOpsOverview({ market }))
    ]);

    return {
      generatedAt: this.now().toISOString(),
      market,
      settlement,
      custody,
      chain,
      engine: { anomalies, overview },
      activeFaults: collectActiveFaults({ settlement, custody, chain, anomalies })
    };
  }

  pauseSettlement(session: OpsSessionInfo, command: { durationSeconds?: number }) {
    const payload = {
      durationSeconds: command.durationSeconds,
      reason: "ops fault lab",
      requestedBy: operatorLabel(session)
    };
    return this.audit(session, "fault_lab.settlement.pause", "settlement_consumer", "settlement-service", payload, () =>
      this.labClient.pauseSettlementConsumer(payload)
    );
  }

  resumeSettlement(session: OpsSessionInfo) {
    return this.audit(session, "fault_lab.settlement.resume", "settlement_consumer", "settlement-service", {}, () =>
      this.labClient.resumeSettlementConsumer()
    );
  }

  injectCustodyFailure(session: OpsSessionInfo, command: { providerName?: string; durationSeconds?: number }) {
    const payload = {
      providerName: command.providerName || undefined,
      durationSeconds: command.durationSeconds,
      reason: "ops fault lab",
      requestedBy: operatorLabel(session)
    };
    return this.audit(session, "fault_lab.custody.inject", "custody_provider", payload.providerName ?? "mock-custody", payload, () =>
      this.labClient.injectCustodyFailure(payload)
    );
  }

  probeCustody(session: OpsSessionInfo, command: { count?: number }) {
    const payload = { network: LAB_NETWORK, count: clampInt(command.count, 1, 10, 3) };
    return this.audit(session, "fault_lab.custody.probe", "custody_route", LAB_NETWORK, payload, () =>
      this.labClient.probeCustodyBroadcast(payload)
    );
  }

  clearCustodyFailure(session: OpsSessionInfo, command: { providerName?: string }) {
    const payload = { providerName: command.providerName || undefined };
    return this.audit(session, "fault_lab.custody.clear", "custody_provider", payload.providerName ?? "all", payload, () =>
      this.labClient.clearCustodyFailure(payload)
    );
  }

  haltChain(session: OpsSessionInfo, command: { durationSeconds?: number }) {
    const payload = {
      durationSeconds: command.durationSeconds,
      reason: "ops fault lab",
      requestedBy: operatorLabel(session)
    };
    return this.audit(session, "fault_lab.chain.halt", "demo_chain", LAB_NETWORK, payload, () =>
      this.labClient.haltChain(payload)
    );
  }

  resumeChain(session: OpsSessionInfo) {
    return this.audit(session, "fault_lab.chain.resume", "demo_chain", LAB_NETWORK, {}, () =>
      this.labClient.resumeChain()
    );
  }

  seedLabDeposit(session: OpsSessionInfo, command: { confirmations?: number }) {
    const payload = { confirmations: command.confirmations };
    return this.audit(session, "fault_lab.chain.seed_deposit", "demo_chain", LAB_NETWORK, payload, () =>
      this.labClient.seedLabDeposit(payload)
    );
  }

  triggerReorg(session: OpsSessionInfo, command: { depth?: number }) {
    const payload = {
      depth: clampInt(command.depth, 1, 11, 6),
      seedIfEmpty: true,
      requestedBy: operatorLabel(session)
    };
    return this.audit(session, "fault_lab.chain.reorg", "demo_chain", LAB_NETWORK, payload, () =>
      this.labClient.triggerChainReorg(payload)
    );
  }

  acknowledgeReorg(session: OpsSessionInfo) {
    const payload = { network: LAB_NETWORK };
    return this.audit(session, "fault_lab.indexer.reorg_acknowledge", "indexer_cursor", LAB_NETWORK, payload, () =>
      this.labClient.acknowledgeIndexerReorg(payload)
    );
  }

  /**
   * Resets the engine book and returns the anomaly report before and after,
   * so the UI can show exactly what the reset broke.
   */
  resetEngine(session: OpsSessionInfo, command: { market?: string; resetSequences?: boolean }) {
    const market = requireMarket(command.market ?? DEFAULT_LAB_MARKET);
    const payload = { market, resetSequences: command.resetSequences === true };
    return this.audit(session, "fault_lab.engine.reset", "spot_market", market, payload, async () => {
      const anomaliesBefore = await this.orderClient.getTradeOpsAnomalies({ market });
      const reset = await this.labClient.resetMatchingEngine(payload);
      const anomaliesAfter = await this.orderClient.getTradeOpsAnomalies({ market });
      return {
        market,
        reset,
        anomalyCountBefore: anomaliesBefore.length,
        anomalyCountAfter: anomaliesAfter.length,
        anomaliesAfter: anomaliesAfter.slice(0, 20)
      };
    });
  }

  /** Clears every lab fault and rebuilds engine books that have drifted from the DB. */
  recoverAll(session: OpsSessionInfo) {
    return this.audit(session, "fault_lab.recover_all", "fault_lab", "all", {}, async () => {
      const steps: Array<{ step: string; status: "succeeded" | "failed" | "skipped"; detail?: unknown }> = [];
      const run = async (step: string, operation: () => Promise<unknown>) => {
        try {
          const detail = await operation();
          steps.push({ step, status: detail === undefined ? "skipped" : "succeeded", detail });
        } catch (error) {
          steps.push({ step, status: "failed", detail: error instanceof Error ? error.message : String(error) });
        }
      };

      await run("settlement.resume", () => this.labClient.resumeSettlementConsumer());
      await run("custody.clear", () => this.labClient.clearCustodyFailure({}));
      await run("chain.resume", () => this.labClient.resumeChain());
      for (const market of LAB_MARKETS) {
        await run(`engine.replay:${market}`, async () => {
          const anomalies = await this.orderClient.getTradeOpsAnomalies({ market });
          if (!anomalies.some((anomaly) => ENGINE_ANOMALY_TYPES.has(String(anomaly.type)))) {
            return undefined;
          }
          return this.orderClient.replayEngineBook({ market });
        });
      }
      await run("indexer.reorg_acknowledge", () =>
        this.labClient.acknowledgeIndexerReorg({ network: LAB_NETWORK })
      );

      return {
        recoveredAt: this.now().toISOString(),
        failedCount: steps.filter((step) => step.status === "failed").length,
        steps
      };
    });
  }

  private audit<T>(
    session: OpsSessionInfo,
    action: string,
    targetType: string,
    targetId: string,
    requestPayload: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runAudited(
      {
        session,
        permission: FAULT_LAB_AUDIT_PERMISSION,
        action,
        targetType,
        targetId,
        requestPayload: JSON.parse(JSON.stringify(requestPayload)) as Record<string, unknown>
      },
      operation
    );
  }
}

async function section(load: () => Promise<Record<string, unknown>>): Promise<FaultLabSection> {
  try {
    return { available: true, data: await load() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function collectActiveFaults(sections: {
  settlement: FaultLabSection;
  custody: FaultLabSection;
  chain: FaultLabSection;
  anomalies: FaultLabSection;
}): FaultLabActiveFault[] {
  const faults: FaultLabActiveFault[] = [];

  if (sections.settlement.available) {
    const pause = sections.settlement.data.pause as { paused?: boolean; expiresAt?: string } | undefined;
    if (pause?.paused) {
      faults.push({ experiment: "settlement", summary: "结算消费者已暂停", expiresAt: pause.expiresAt });
    }
  }

  if (sections.custody.available) {
    const injections = (sections.custody.data.injections ?? []) as Array<{ providerName?: string; expiresAt?: string }>;
    for (const injection of injections) {
      faults.push({
        experiment: "custody",
        summary: `${injection.providerName ?? "provider"} 广播故障注入中`,
        expiresAt: injection.expiresAt
      });
    }
  }

  if (sections.chain.available && sections.chain.data.halted) {
    const halt = sections.chain.data.halt as { until?: string } | undefined;
    faults.push({ experiment: "chain", summary: "模拟链已暂停出块", expiresAt: halt?.until });
  }

  if (sections.anomalies.available) {
    const items = (sections.anomalies.data.items ?? []) as Array<{ type?: string }>;
    const engineAnomalies = items.filter((item) => ENGINE_ANOMALY_TYPES.has(String(item.type))).length;
    if (engineAnomalies > 0) {
      faults.push({ experiment: "engine", summary: `撮合引擎与数据库不一致（${engineAnomalies} 条异常）` });
    }
  }

  return faults;
}

function requireMarket(market: string): string {
  if (!LAB_MARKETS.includes(market)) {
    throw new OpsConsoleError("VALIDATION_ERROR", 400, `Unsupported market ${market}`);
  }
  return market;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function operatorLabel(session: OpsSessionInfo): string {
  return session.email ?? session.userId;
}
