import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SPOT_MARKET, listAssetCodes, listSpotMarkets } from "@web3-cex/domain";

import { OpsConsoleApplicationService } from "../application/ops-console-application-service.js";
import type { OpsMarketClient, OpsSessionInfo } from "../domain/clients.js";
import { InMemoryOpsActionAuditRepository } from "../infrastructure/in-memory-ops-action-audit-repository.js";

// Only the market client is exercised here; every other upstream is unused.
const unused = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("unexpected upstream call");
    }
  }
) as never;

const session: OpsSessionInfo = {
  sessionId: "session-1",
  userId: "ops-user",
  email: "ops@example.com",
  displayName: "Ops User",
  roles: ["ops_admin"],
  permissions: ["ops.markets.read", "ops.markets.manage"],
  createdAt: "2026-10-10T00:00:00.000Z",
  expiresAt: "2026-10-10T12:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
  active: true,
  status: "active"
} as OpsSessionInfo;

function createService(marketClient?: OpsMarketClient) {
  const audit = new InMemoryOpsActionAuditRepository();
  const service = new OpsConsoleApplicationService(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    audit,
    undefined,
    { marketClient, now: () => new Date("2026-10-10T08:00:00.000Z") }
  );
  return { service, audit };
}

/** Fake risk-service keeping overrides in memory, like the real MarketStatusService. */
function createFakeRisk() {
  const overrides = new Map<string, Record<string, unknown>>();
  const calls: Array<Record<string, unknown>> = [];
  const client: OpsMarketClient = {
    async listMarkets() {
      return listSpotMarkets({ includeDelisted: true }).map((market) => ({
        market,
        status: (overrides.get(market)?.status as string | undefined) ?? "listed",
        override: overrides.get(market) ?? null
      }));
    },
    async setMarketStatus(command) {
      calls.push({ ...command });
      if (command.status === "listed") {
        overrides.delete(command.market);
      } else {
        overrides.set(command.market, {
          market: command.market,
          status: command.status,
          reason: command.reason ?? null,
          updatedBy: command.operator,
          updatedAt: "2026-10-10T08:00:00.000Z"
        });
      }
      return { market: command.market, status: command.status, override: overrides.get(command.market) ?? null };
    }
  };
  return { client, calls };
}

test("market config endpoint mirrors config/markets.json", () => {
  const { service } = createService();
  const config = service.getMarketConfig();
  assert.equal(config.defaultMarket, DEFAULT_SPOT_MARKET);
  assert.deepEqual(config.markets.map((item) => item.market), listSpotMarkets({ includeDelisted: true }));
  assert.deepEqual(config.assets.map((item) => item.code), listAssetCodes());
  assert.ok(config.markets.some((item) => item.market === "SOL-USDT" && item.baseAsset === "SOL"));
});

test("halt and resume go through risk-service and are audited", async () => {
  const risk = createFakeRisk();
  const { service } = createService(risk.client);

  await service.setMarketStatus(session, { market: "SOL-USDT", status: "halted", reason: "maintenance" });
  let report = await service.listMarkets();
  assert.equal(report.statusSource, "risk-service");
  assert.equal(report.markets.find((item) => item.market === "SOL-USDT")?.status, "halted");
  assert.equal(report.markets.find((item) => item.market === "ETH-USDT")?.status, "listed");
  assert.equal(risk.calls[0]?.operator, "ops@example.com");

  await service.setMarketStatus(session, { market: "SOL-USDT", status: "listed" });
  report = await service.listMarkets();
  assert.equal(report.markets.find((item) => item.market === "SOL-USDT")?.status, "listed");

  const logs = await service.listActionAuditLogs({});
  assert.deepEqual(
    logs.items.map((item) => [item.action, item.targetId, item.permission, item.status]).sort(),
    [
      ["market.halt", "SOL-USDT", "ops.markets.manage", "succeeded"],
      ["market.resume", "SOL-USDT", "ops.markets.manage", "succeeded"]
    ]
  );
});

test("halt input is validated before reaching risk-service", async () => {
  const risk = createFakeRisk();
  const { service } = createService(risk.client);
  await assert.rejects(
    service.setMarketStatus(session, { market: "SOL-USDT", status: "halted" }),
    /reason is required/
  );
  await assert.rejects(
    service.setMarketStatus(session, { market: "DOGE-USDT", status: "halted", reason: "x" }),
    /Unknown market/
  );
  assert.equal(risk.calls.length, 0);
});

test("market list falls back to config defaults when risk-service is down", async () => {
  const { service } = createService({
    async listMarkets() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3008");
    },
    async setMarketStatus() {
      throw new Error("down");
    }
  });
  const report = await service.listMarkets();
  assert.equal(report.statusSource, "config");
  assert.match(report.statusError ?? "", /ECONNREFUSED/);
  assert.deepEqual(report.markets.map((item) => item.market), listSpotMarkets({ includeDelisted: true }));
  assert.ok(report.markets.every((item) => item.status === item.configuredStatus));
});
