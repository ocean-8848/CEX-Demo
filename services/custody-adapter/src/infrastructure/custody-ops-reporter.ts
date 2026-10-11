import {
  defaultCustodyAlertThresholds,
  evaluateCustodyAlertThresholds,
  type CustodyAlertThresholds,
  type CustodyOpsOverview,
  type CustodyOpsReport,
  type CustodyProviderSlaSnapshot,
  type CustodyWorkerScheduleSnapshot
} from "../application/custody-ops.js";
import type { CustodyProviderRuntimeRegistry } from "../application/custody-provider-runtime-registry.js";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface BacklogRow extends QueryResultRow {
  pending_sync_count: string;
  retryable_count: string;
  failed_count: string;
  oldest_pending_sync_at: Date | null;
}

interface ProviderSlaRow extends QueryResultRow {
  provider_name: string;
  network: string;
  transfer_count: string;
  confirmed_count: string;
  failed_count: string;
  pending_count: string;
  confirmation_rate: string | null;
  average_confirmation_latency_seconds: string | null;
  broadcast_attempt_count: string;
  broadcast_success_rate: string | null;
  sync_attempt_count: string;
  sync_success_rate: string | null;
  retry_attempt_count: string;
}

export class CustodyOpsReporter {
  constructor(
    private readonly db: Pool | PoolClient,
    private readonly runtimeRegistry: CustodyProviderRuntimeRegistry
  ) {}

  async buildOpsOverview(params: {
    generatedAt?: string;
    thresholds?: Partial<CustodyAlertThresholds>;
    schedules?: CustodyWorkerScheduleSnapshot[];
  } = {}): Promise<CustodyOpsOverview> {
    const generatedAt = params.generatedAt ?? new Date().toISOString();
    const backlog = await this.getBacklogSummary(generatedAt);
    const routes = this.runtimeRegistry.listRouteSnapshots();

    return evaluateCustodyAlertThresholds(
      {
        generatedAt,
        backlog,
        routes,
        schedules: params.schedules ?? [],
        openCircuitCount: routes.filter((route) => route.circuitState === "open").length,
        unhealthyRouteCount: routes.filter((route) => route.healthStatus === "unhealthy").length
      },
      {
        ...defaultCustodyAlertThresholds(),
        ...params.thresholds
      }
    );
  }

  async buildOpsReport(params: {
    generatedAt?: string;
    thresholds?: Partial<CustodyAlertThresholds>;
    schedules?: CustodyWorkerScheduleSnapshot[];
    windowHours?: number;
  } = {}): Promise<CustodyOpsReport> {
    const generatedAt = params.generatedAt ?? new Date().toISOString();
    const windowHours = params.windowHours ?? 24;
    const overview = await this.buildOpsOverview({
      generatedAt,
      thresholds: params.thresholds,
      schedules: params.schedules
    });
    const providerSla = await this.buildProviderSlaSnapshots({
      windowHours
    });

    return {
      generatedAt,
      windowHours,
      overview,
      providerSla
    };
  }

  private async getBacklogSummary(generatedAt: string) {
    const result = await this.db.query<BacklogRow>(
      `select
         (select count(*)::text from custody_transfers where status in ('accepted', 'broadcasted')) as pending_sync_count,
         (select count(*)::text from custody_transfers where status = 'failed' and next_retry_at is not null) as retryable_count,
         (select count(*)::text from custody_transfers where status = 'failed') as failed_count,
         (select min(updated_at) from custody_transfers where status in ('accepted', 'broadcasted')) as oldest_pending_sync_at`,
      []
    );

    const row = result.rows[0];
    const nowAt = new Date(generatedAt);

    return {
      pendingSyncCount: Number(row?.pending_sync_count ?? "0"),
      retryableCount: Number(row?.retryable_count ?? "0"),
      failedCount: Number(row?.failed_count ?? "0"),
      oldestPendingSyncAgeSeconds: row?.oldest_pending_sync_at
        ? Math.max(
            0,
            Math.trunc((nowAt.getTime() - row.oldest_pending_sync_at.getTime()) / 1000)
          )
        : undefined
    };
  }

  private async buildProviderSlaSnapshots(params: {
    windowHours: number;
  }): Promise<CustodyProviderSlaSnapshot[]> {
    const routes = this.runtimeRegistry.listRouteSnapshots();
    const result = await this.db.query<ProviderSlaRow>(
      `with transfer_window as (
         select *
         from custody_transfers
         where created_at >= now() - ($1::text || ' hours')::interval
       ),
       transfer_stats as (
         select provider_name,
                network,
                count(*)::text as transfer_count,
                count(*) filter (where status = 'confirmed')::text as confirmed_count,
                count(*) filter (where status = 'failed')::text as failed_count,
                count(*) filter (where status in ('accepted', 'broadcasted'))::text as pending_count,
                case
                  when count(*) = 0 then null
                  else round(
                    (count(*) filter (where status = 'confirmed')::numeric / count(*)::numeric) * 100,
                    2
                  )::text
                end as confirmation_rate,
                round(avg(extract(epoch from (confirmed_at - broadcasted_at)))::numeric, 2)::text
                  as average_confirmation_latency_seconds
         from transfer_window
         group by provider_name, network
       ),
       attempt_stats as (
         select t.provider_name,
                t.network,
                count(*) filter (where a.action in ('broadcast', 'retry'))::text as broadcast_attempt_count,
                case
                  when count(*) filter (where a.action in ('broadcast', 'retry')) = 0 then null
                  else round(
                    (
                      count(*) filter (
                        where a.action in ('broadcast', 'retry') and a.status = 'succeeded'
                      )::numeric /
                      count(*) filter (where a.action in ('broadcast', 'retry'))::numeric
                    ) * 100,
                    2
                  )::text
                end as broadcast_success_rate,
                count(*) filter (where a.action = 'sync_status')::text as sync_attempt_count,
                case
                  when count(*) filter (where a.action = 'sync_status') = 0 then null
                  else round(
                    (
                      count(*) filter (
                        where a.action = 'sync_status' and a.status = 'succeeded'
                      )::numeric /
                      count(*) filter (where a.action = 'sync_status')::numeric
                    ) * 100,
                    2
                  )::text
                end as sync_success_rate,
                count(*) filter (where a.action = 'retry')::text as retry_attempt_count
         from custody_transfer_attempts a
         join custody_transfers t
           on t.custody_transfer_id = a.custody_transfer_id
         where a.created_at >= now() - ($1::text || ' hours')::interval
         group by t.provider_name, t.network
       )
       select coalesce(ts.provider_name, ats.provider_name) as provider_name,
              coalesce(ts.network, ats.network) as network,
              coalesce(ts.transfer_count, '0') as transfer_count,
              coalesce(ts.confirmed_count, '0') as confirmed_count,
              coalesce(ts.failed_count, '0') as failed_count,
              coalesce(ts.pending_count, '0') as pending_count,
              ts.confirmation_rate,
              ts.average_confirmation_latency_seconds,
              coalesce(ats.broadcast_attempt_count, '0') as broadcast_attempt_count,
              ats.broadcast_success_rate,
              coalesce(ats.sync_attempt_count, '0') as sync_attempt_count,
              ats.sync_success_rate,
              coalesce(ats.retry_attempt_count, '0') as retry_attempt_count
       from transfer_stats ts
       full outer join attempt_stats ats
         on ats.provider_name = ts.provider_name
        and ats.network = ts.network`,
      [String(params.windowHours)]
    );

    const byRoute = new Map<string, ProviderSlaRow>();
    for (const row of result.rows) {
      byRoute.set(toRouteKey(row.provider_name, row.network), row);
    }

    return routes.map((route) => {
      const row = byRoute.get(toRouteKey(route.providerName, route.network));

      return {
        providerName: route.providerName,
        network: route.network,
        priority: route.priority,
        healthStatus: route.healthStatus,
        circuitState: route.circuitState,
        transferCount: Number(row?.transfer_count ?? "0"),
        confirmedCount: Number(row?.confirmed_count ?? "0"),
        failedCount: Number(row?.failed_count ?? "0"),
        pendingCount: Number(row?.pending_count ?? "0"),
        confirmationRate: parseOptionalNumber(row?.confirmation_rate),
        averageConfirmationLatencySeconds: parseOptionalNumber(
          row?.average_confirmation_latency_seconds
        ),
        broadcastAttemptCount: Number(row?.broadcast_attempt_count ?? "0"),
        broadcastSuccessRate: parseOptionalNumber(row?.broadcast_success_rate),
        syncAttemptCount: Number(row?.sync_attempt_count ?? "0"),
        syncSuccessRate: parseOptionalNumber(row?.sync_success_rate),
        retryAttemptCount: Number(row?.retry_attempt_count ?? "0"),
        routeSelectionCount: route.routeSelectionCount,
        lastSelectionAt: route.lastSelectionAt,
        lastSuccessAt: route.lastSuccessAt,
        lastFailureAt: route.lastFailureAt,
        lastHealthCheckedAt: route.lastHealthCheckedAt,
        lastHealthLatencyMs: route.lastHealthLatencyMs
      };
    });
  }
}

function parseOptionalNumber(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toRouteKey(providerName: string, network: string): string {
  return `${providerName}:${network}`;
}
