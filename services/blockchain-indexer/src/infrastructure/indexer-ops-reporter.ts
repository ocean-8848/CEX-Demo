import type { QueryResultRow } from "pg";

import type { EvmClient, EvmNetwork } from "../domain/evm-client.js";
import {
  defaultIndexerAlertThresholds,
  evaluateIndexerAlertThresholds,
  type IndexerAlertThresholds,
  type IndexerCursorHealth,
  type IndexerOpsOverview
} from "../application/indexer-ops.js";
import type { SqlClient } from "./postgres.js";

interface BacklogRow extends QueryResultRow {
  pending_deposit_count: string;
  pending_withdrawal_count: string;
  oldest_pending_deposit_at: Date | null;
  oldest_pending_withdrawal_at: Date | null;
}

interface CursorRow extends QueryResultRow {
  observation_type: "deposit" | "withdrawal";
  network: EvmNetwork;
  last_scanned_block: string | number | null;
  last_finalized_block: string | number | null;
  reorg_detected_at: Date | null;
  updated_at: Date;
}

export class IndexerOpsReporter {
  constructor(
    private readonly db: SqlClient,
    private readonly evmClientFactory: (params: {
      network: EvmNetwork;
      rpcUrl: string;
    }) => EvmClient,
    private readonly rpcUrls: Partial<Record<EvmNetwork, string>>
  ) {}

  async buildOpsOverview(params: {
    generatedAt?: string;
    thresholds?: Partial<IndexerAlertThresholds>;
    networks?: EvmNetwork[];
  } = {}): Promise<IndexerOpsOverview> {
    const generatedAt = params.generatedAt ?? new Date().toISOString();
    const networks = params.networks ?? this.resolveConfiguredNetworks();
    const [backlog, cursors] = await Promise.all([
      this.getBacklogSummary(generatedAt),
      this.listCursorHealth(generatedAt, networks)
    ]);

    return evaluateIndexerAlertThresholds(
      {
        generatedAt,
        backlog,
        cursors,
        reorgCursorCount: cursors.filter((cursor) => cursor.reorgDetectedAt).length
      },
      {
        ...defaultIndexerAlertThresholds(),
        ...params.thresholds
      }
    );
  }

  private resolveConfiguredNetworks(): EvmNetwork[] {
    return (["ethereum", "bsc", "base"] as EvmNetwork[]).filter(
      (network) => typeof this.rpcUrls[network] === "string" && this.rpcUrls[network]
    );
  }

  private async getBacklogSummary(generatedAt: string) {
    const result = await this.db.query<BacklogRow>(
      `select
         (select count(*)::text from blockchain_deposit_observations where status in ('detected', 'confirming')) as pending_deposit_count,
         (select count(*)::text from blockchain_withdrawal_observations where status != 'confirmed') as pending_withdrawal_count,
         (select min(created_at) from blockchain_deposit_observations where status in ('detected', 'confirming')) as oldest_pending_deposit_at,
         (select min(updated_at) from blockchain_withdrawal_observations where status != 'confirmed') as oldest_pending_withdrawal_at`,
      []
    );

    const row = result.rows[0];
    const nowAt = new Date(generatedAt);

    return {
      pendingDepositCount: Number(row?.pending_deposit_count ?? "0"),
      pendingWithdrawalCount: Number(row?.pending_withdrawal_count ?? "0"),
      oldestPendingDepositAgeSeconds: row?.oldest_pending_deposit_at
        ? Math.max(
            0,
            Math.trunc((nowAt.getTime() - row.oldest_pending_deposit_at.getTime()) / 1000)
          )
        : undefined,
      oldestPendingWithdrawalAgeSeconds: row?.oldest_pending_withdrawal_at
        ? Math.max(
            0,
            Math.trunc(
              (nowAt.getTime() - row.oldest_pending_withdrawal_at.getTime()) / 1000
            )
          )
        : undefined
    };
  }

  private async listCursorHealth(
    generatedAt: string,
    networks: EvmNetwork[]
  ): Promise<IndexerCursorHealth[]> {
    if (networks.length === 0) {
      return [];
    }

    const result = await this.db.query<CursorRow>(
      `select observation_type, network, last_scanned_block, last_finalized_block,
              reorg_detected_at, updated_at
       from blockchain_scan_cursors
       where network = any($1::text[])
       order by network asc, observation_type asc`,
      [networks]
    );

    const headBlocks = await this.loadHeadBlocks(networks);
    const nowAt = new Date(generatedAt);

    return result.rows.map((row) => {
      const headBlock = headBlocks.get(row.network);
      const lastScannedBlock = toOptionalNumber(row.last_scanned_block);

      return {
        observationType: row.observation_type,
        network: row.network,
        headBlock,
        lastScannedBlock,
        lastFinalizedBlock: toOptionalNumber(row.last_finalized_block),
        lagBlocks:
          headBlock !== undefined && lastScannedBlock !== undefined
            ? Math.max(0, headBlock - lastScannedBlock)
            : undefined,
        cursorAgeSeconds: Math.max(
          0,
          Math.trunc((nowAt.getTime() - row.updated_at.getTime()) / 1000)
        ),
        reorgDetectedAt: row.reorg_detected_at?.toISOString()
      };
    });
  }

  private async loadHeadBlocks(networks: EvmNetwork[]): Promise<Map<EvmNetwork, number>> {
    const headBlocks = new Map<EvmNetwork, number>();

    await Promise.all(
      networks.map(async (network) => {
        const rpcUrl = this.rpcUrls[network];
        if (!rpcUrl) {
          return;
        }

        try {
          const client = this.evmClientFactory({
            network,
            rpcUrl
          });
          headBlocks.set(network, await client.getBlockNumber());
        } catch {
          return;
        }
      })
    );

    return headBlocks;
  }
}

function toOptionalNumber(value: string | number | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  return Number(value);
}
