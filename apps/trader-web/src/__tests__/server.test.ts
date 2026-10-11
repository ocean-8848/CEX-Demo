import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { DEFAULT_SPOT_MARKET, listSpotMarkets } from "@web3-cex/domain";

import {
  DEFAULT_PUBLIC_DIR,
  buildRuntimeConfig,
  createTraderWebServer
} from "../server.js";

test("buildRuntimeConfig derives websocket urls from http base urls", () => {
  const config = buildRuntimeConfig({
    TRADER_WEB_GATEWAY_URL: "http://127.0.0.1:3901/",
    TRADER_WEB_MARKET_DATA_URL: "https://market.example.com/"
  });

  assert.equal(config.gatewayBaseUrl, "http://127.0.0.1:3901");
  assert.equal(config.gatewayWsUrl, "ws://127.0.0.1:3901/api/v1/gateway/realtime");
  assert.equal(config.marketDataWsUrl, "wss://market.example.com/api/v1/market-data/ws");
});

test("trader-web proxies gateway and market-data endpoints and serves config", async (t) => {
  let forwardedAuthorization = "";
  const gateway = createServer((request, response) => {
    forwardedAuthorization = String(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ path: request.url, service: "gateway" }));
  });
  const market = createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify([{ market: "ETH-USDT" }]));
  });

  await listen(gateway);
  await listen(market);
  const gatewayAddress = gateway.address();
  const marketAddress = market.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  assert.ok(marketAddress && typeof marketAddress === "object");

  const trader = createTraderWebServer(
    {
      ...buildRuntimeConfig({}),
      appTitle: "Trader Web",
      gatewayBaseUrl: `http://127.0.0.1:${gatewayAddress.port}`,
      marketDataBaseUrl: `http://127.0.0.1:${marketAddress.port}`,
      gatewayWsUrl: "ws://127.0.0.1:3007/api/v1/gateway/realtime",
      marketDataWsUrl: "ws://127.0.0.1:3012/api/v1/market-data/ws",
      gatewayHttpBasePath: "/api/gateway",
      marketDataHttpBasePath: "/api/market"
    },
    DEFAULT_PUBLIC_DIR
  );
  await listen(trader);
  const traderAddress = trader.address();
  assert.ok(traderAddress && typeof traderAddress === "object");
  const baseUrl = `http://127.0.0.1:${traderAddress.port}`;

  t.after(async () => {
    await close(trader);
    await close(gateway);
    await close(market);
  });

  const configResponse = await fetch(`${baseUrl}/api/config`);
  const gatewayResponse = await fetch(`${baseUrl}/api/gateway/auth/me`, {
    headers: {
      authorization: "Bearer token-1"
    }
  });
  const marketResponse = await fetch(`${baseUrl}/api/market/tickers`);
  const indexResponse = await fetch(`${baseUrl}/`);

  assert.equal(configResponse.status, 200);
  assert.equal(gatewayResponse.status, 200);
  assert.equal(marketResponse.status, 200);
  assert.equal(indexResponse.status, 200);
  assert.equal(forwardedAuthorization, "Bearer token-1");

  const proxiedGateway = (await gatewayResponse.json()) as { path: string };
  const config = (await configResponse.json()) as { appTitle: string };
  const indexHtml = await indexResponse.text();

  assert.equal(proxiedGateway.path, "/api/v1/gateway/auth/me");
  assert.equal(config.appTitle, "Trader Web");
  assert.ok(indexHtml.includes("market-board"));
});

test("buildRuntimeConfig exposes market definitions and demo settings", () => {
  const config = buildRuntimeConfig({});
  assert.ok(config.markets.some((market) => market.market === "ETH-USDT"));
  // Markets / assets come from config/markets.json, including SOL-USDT and the SOL faucet.
  assert.deepEqual(config.markets.map((market) => market.market), listSpotMarkets());
  assert.equal(config.defaultMarket, DEFAULT_SPOT_MARKET);
  const sol = config.assets.find((asset) => asset.code === "SOL");
  assert.ok(config.markets.some((market) => market.market === "SOL-USDT"));
  assert.ok(sol?.faucet && Number(sol.faucet.maxAmount) > 0);
  assert.deepEqual(sol?.networks, ["ethereum"]);
  assert.equal(config.demo.enabled, true);
  assert.equal(config.demo.account?.email, "demo-trader@example.com");

  const disabled = buildRuntimeConfig({ TRADER_WEB_DEMO_MODE: "false" });
  assert.equal(disabled.demo.enabled, false);
  assert.equal(disabled.demo.account, undefined);
});

test("trader-web only proxies whitelisted demo-simulator routes", async (t) => {
  const seen: string[] = [];
  const simulator = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true }));
  });
  await listen(simulator);
  const simulatorAddress = simulator.address();
  assert.ok(simulatorAddress && typeof simulatorAddress === "object");

  const trader = createTraderWebServer(
    buildRuntimeConfig({
      TRADER_WEB_DEMO_SIMULATOR_URL: `http://127.0.0.1:${simulatorAddress.port}`
    }),
    DEFAULT_PUBLIC_DIR
  );
  await listen(trader);
  const traderAddress = trader.address();
  assert.ok(traderAddress && typeof traderAddress === "object");
  const baseUrl = `http://127.0.0.1:${traderAddress.port}`;
  t.after(async () => {
    await close(trader);
    await close(simulator);
  });

  const status = await fetch(`${baseUrl}/api/demo/status`);
  const faucet = await fetch(`${baseUrl}/api/demo/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetCode: "USDT", amount: "10" })
  });
  // Maker controls must stay local to the simulator.
  const makers = await fetch(`${baseUrl}/api/demo/makers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paused: true })
  });

  assert.equal(status.status, 200);
  assert.equal(faucet.status, 200);
  assert.equal(makers.status, 404);
  assert.deepEqual(seen, ["GET /api/demo/status", "POST /api/demo/faucet"]);
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}
