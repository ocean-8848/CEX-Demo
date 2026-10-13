// End-to-end checks for the M2–M5 features against a running, seeded stack
// (`pnpm demo:up`). Every check talks to real services; nothing is mocked.
//
//   node ./scripts/verify-feature-e2e.mjs [section...]
//
// Sections: apikey, websocket, fees, sol, notifications, security, lab, controls.
// Without arguments all sections run. The demo trader is restored afterwards
// (2FA disabled, faults recovered); KYC tier and balances change, which
// `pnpm demo:prepare` resets.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  DEMO_OPS,
  DEMO_OPS_REVIEWER,
  DEMO_TRADER,
  DEMO_WITHDRAWAL_ADDRESS,
  fetchJson,
  generateTotpCode,
  loadDemoConfig
} from "./mvp-demo-lib.mjs";

const config = loadDemoConfig();
const TRADER_WEB = process.env.TRADER_WEB_BASE_URL ?? "http://127.0.0.1:3013";
const OPS = `${process.env.OPS_CONSOLE_BASE_URL ?? "http://127.0.0.1:3006"}/api/v1/ops`;
const GATEWAY = `${config.gatewayBaseUrl}/api/v1/gateway`;
const SETTLEMENT = config.settlementBaseUrl;

// The market M4-3 lists purely through config/markets.json (acceptance target).
const CONFIG_LISTED_MARKET = process.env.E2E_CONFIG_LISTED_MARKET ?? "SOL-USDT";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 1_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

/** TOTP codes are single-use per 30s window; wait for a fresh window when needed. */
const usedWindows = new Map();
async function freshTotp(secret) {
  const window = () => Math.floor(Date.now() / 30_000);
  while (usedWindows.get(secret) === window()) {
    await sleep(500);
  }
  usedWindows.set(secret, window());
  return generateTotpCode(secret, new Date()).code;
}

async function http(url, { method, token, body, headers = {} } = {}) {
  const response = await fetch(url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload, headers: response.headers };
}

const gateway = (path, options) => http(`${GATEWAY}${path}`, options);
const items = (value) => (Array.isArray(value) ? value : value?.items ?? []);

async function traderLogin(twoFactorCode) {
  const runtime = await fetchJson(`${TRADER_WEB}/api/config`);
  const account = runtime.demo?.account ?? { email: DEMO_TRADER.email, password: DEMO_TRADER.password };
  return gateway("/auth/sessions", { body: { ...account, ...(twoFactorCode ? { twoFactorCode } : {}) } });
}

async function opsLogin(operator) {
  let result;
  // Another process (an earlier run, the UI e2e) may have used this window's code.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await http(`${OPS}/auth/login`, {
      body: { email: operator.email, password: operator.password, twoFactorCode: await freshTotp(operator.twoFactorSecret) }
    });
    if (!JSON.stringify(result.body).includes("TWO_FACTOR_CODE_REUSED")) {
      break;
    }
  }
  assert.equal(result.status, 201, `ops login for ${operator.email}: ${JSON.stringify(result.body)}`);
  return result.body.token;
}

const ops = (token, path, body) => http(`${OPS}${path}`, { token, body });

async function bestAsk(market) {
  // Makers resume right after demo:verify:flow; markets without seeded
  // liquidity (e.g. SOL-USDT) need a few simulator ticks before quoting.
  const depth = await waitFor(
    `${market} asks (are the simulator makers running?)`,
    async () => {
      const book = await fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${market}`);
      return book.asks?.length ? book : null;
    },
    30_000
  );
  return depth.asks[0].price;
}

async function placeOrder(token, accountId, order) {
  const idempotencyKey = randomUUID();
  return gateway("/orders", {
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: { accountId, side: "buy", type: "limit", timeInForce: "ioc", quantity: "0.01", ...order, idempotencyKey }
  });
}

async function waitSettled(orderId) {
  return waitFor(`settlement of order ${orderId}`, async () => {
    const result = items(await fetchJson(`${SETTLEMENT}/api/v1/settlement/trades?orderId=${orderId}`));
    return result.length > 0 && result.every((item) => item.status === "settled") ? result : null;
  });
}

async function reconciliationMismatches(opsToken) {
  const report = await ops(opsToken, "/ledger/reconciliation");
  assert.equal(report.status, 200, `ledger reconciliation: ${JSON.stringify(report.body)}`);
  return report.body.mismatchCount;
}

// ---------------------------------------------------------------------------

const sections = {
  /** M2-4: keyId + secret, nonce anti-replay, scopes, revocation. */
  async apikey(ctx) {
    const created = await gateway("/auth/api-keys", {
      token: ctx.token,
      headers: { "idempotency-key": randomUUID() },
      body: { label: `e2e-${Date.now()}`, scopes: ["trade"] }
    });
    assert.equal(created.status, 201);
    assert.match(created.body.keyId, /^ak_/);
    assert.deepEqual(created.body.scopes, ["read", "trade"]);
    const sign = (method, path, body = "", nonce = randomUUID()) => {
      const timestamp = String(Date.now());
      const canonical = [method, `/api/v1/gateway${path}`, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n");
      return {
        "x-api-key": created.body.keyId,
        "x-api-timestamp": timestamp,
        "x-api-nonce": nonce,
        "x-api-signature": createHmac("sha256", created.body.secret).update(canonical).digest("hex")
      };
    };
    const headers = sign("GET", "/balances");
    assert.equal((await gateway("/balances", { headers })).status, 200, "signed request");
    const replay = await gateway("/balances", { headers });
    assert.equal(replay.status, 401, "nonce replay is rejected");
    const withdrawBody = JSON.stringify({ ledgerAccountId: DEMO_TRADER.accountId, assetCode: "USDT", network: "ethereum", toAddress: DEMO_WITHDRAWAL_ADDRESS, amount: "1" });
    const scope = await fetch(`${GATEWAY}/withdrawals/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sign("POST", "/withdrawals/validate", withdrawBody) },
      body: withdrawBody
    });
    assert.equal(scope.status, 403, "withdraw scope is required");
    await gateway(`/auth/api-keys/${created.body.apiKeyId}/revoke`, { token: ctx.token, body: {} });
    assert.equal((await gateway("/balances", { headers: sign("GET", "/balances") })).status, 401, "revoked key");
    return "signed 200 · replay 401 · scope 403 · revoked 401";
  },

  /** M5-3: Origin allow-list and per-connection rate limiting. */
  async websocket(ctx) {
    const require = createRequire(new URL("../services/api-gateway/package.json", import.meta.url));
    const { WebSocket } = require("ws");
    const url = `${config.gatewayBaseUrl.replace(/^http/, "ws")}/api/v1/gateway/realtime`;
    const open = (origin) =>
      new Promise((resolve) => {
        const socket = new WebSocket(url, origin ? { origin } : {});
        const events = [];
        socket.on("unexpected-response", (_request, response) => resolve({ rejected: response.statusCode }));
        socket.on("open", () => resolve({ socket, events }));
        socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
        socket.on("close", (code) => events.push({ closed: code }));
        socket.on("error", () => undefined);
      });
    assert.equal((await open("https://evil.example")).rejected, 403, "foreign Origin is rejected");
    const { socket, events } = await open(TRADER_WEB);
    socket.send(JSON.stringify({ type: "auth", token: ctx.token }));
    await waitFor("ws authenticated", () => events.some((event) => event.type === "authenticated"), 5_000, 100);
    for (let index = 0; index < 80; index += 1) {
      socket.send(JSON.stringify({ type: "ping" }));
    }
    const closed = await waitFor("ws flood close", () => events.find((event) => event.closed), 5_000, 100);
    assert.equal(closed.closed, 4008, "flooding closes with 4008");
    assert.ok(events.some((event) => /rate limit/.test(event.message ?? "")), "rate limit errors were sent");
    return "evil origin 403 · flood closed 4008";
  },

  /** M2-2 + M3-3: dual fees and a balanced T-account view of a real trade. */
  async fees(ctx) {
    const market = config.demoMarket;
    const order = await placeOrder(ctx.token, ctx.accountId, { market, price: await bestAsk(market) });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.status, "filled", "crossing IOC fills");
    const [settlement] = await waitSettled(order.body.orderId);
    assert.ok(Number(settlement.buyerFeeAmount) > 0, "buyer pays a base-asset fee");
    const journals = await gateway(`/trades/${settlement.tradeId}/journals`, { token: ctx.token });
    assert.equal(journals.status, 200);
    assert.equal(journals.body.settled, true);
    for (const journal of journals.body.journals) {
      assert.equal(journal.balanced, true, `journal ${journal.stage} balances`);
    }
    const serialized = JSON.stringify(journals.body);
    assert.ok(serialized.includes("对手方"), "counterparty is masked");
    assert.ok(!serialized.includes(DEMO_TRADER.accountId), "own account id is not exposed");
    return `trade ${settlement.tradeId.slice(0, 8)} settled · ${journals.body.journals.length} balanced journals`;
  },

  /** M4-3: SOL-USDT from config — trading, deposit, halt / resume. */
  async sol(ctx) {
    const runtime = await fetchJson(`${TRADER_WEB}/api/config`);
    assert.ok(runtime.markets.some((item) => item.market === CONFIG_LISTED_MARKET), `${CONFIG_LISTED_MARKET} is configured`);
    const order = await placeOrder(ctx.token, ctx.accountId, { market: CONFIG_LISTED_MARKET, price: await bestAsk(CONFIG_LISTED_MARKET), quantity: "0.1" });
    assert.equal(order.body.status, "filled");
    await waitSettled(order.body.orderId);

    const faucet = await http(`${TRADER_WEB}/api/demo/faucet`, { token: ctx.token, body: { assetCode: CONFIG_LISTED_MARKET.split("-")[0], amount: "1" } });
    assert.equal(faucet.status, 201, JSON.stringify(faucet.body));
    await waitFor("SOL deposit credited", async () =>
      items((await gateway("/deposits?limit=5", { token: ctx.token })).body).some(
        (deposit) => deposit.txHash === faucet.body.txHash && deposit.status === "credited"
      ), 60_000);

    // Rest 5% under the best bid: inside the risk price band, below every ask.
    const solDepth = await fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${CONFIG_LISTED_MARKET}`);
    const restPrice = (Number(solDepth.bids[0].price) * 0.95).toFixed(2);
    const resting = await placeOrder(ctx.token, ctx.accountId, { market: CONFIG_LISTED_MARKET, price: restPrice, timeInForce: "gtc", quantity: "0.1" });
    assert.equal(resting.body.status, "accepted");
    try {
      assert.equal((await ops(ctx.opsToken, `/markets/${CONFIG_LISTED_MARKET}/status`, { status: "halted", reason: "e2e" })).status, 201);
      await sleep(1_500);
      const blocked = await placeOrder(ctx.token, ctx.accountId, { market: CONFIG_LISTED_MARKET, price: restPrice, timeInForce: "gtc", quantity: "0.1" });
      assert.equal(blocked.status, 409);
      assert.match(JSON.stringify(blocked.body), /MARKET_HALTED/);
      const cancel = await gateway(`/orders/${resting.body.orderId}/cancel`, { token: ctx.token, body: {} });
      assert.equal(cancel.body.status, "cancelled", "cancels still work while halted");
    } finally {
      await ops(ctx.opsToken, `/markets/${CONFIG_LISTED_MARKET}/status`, { status: "listed" });
    }
    await sleep(1_500);
    const after = await placeOrder(ctx.token, ctx.accountId, { market: CONFIG_LISTED_MARKET, price: await bestAsk(CONFIG_LISTED_MARKET), quantity: "0.1" });
    assert.equal(after.status, 201, "orders accepted again after resume");
    return "SOL fill settled · SOL deposit credited · halt 409 / cancel ok / resume ok";
  },

  /** M4-2 + M4-5: notification read state and the ledger statement. */
  async notifications(ctx) {
    await gateway("/notifications/read-all", { token: ctx.token, body: {} });
    assert.equal((await gateway("/notifications/unread-count", { token: ctx.token })).body.unreadCount, 0);
    const faucet = await http(`${TRADER_WEB}/api/demo/faucet`, { token: ctx.token, body: { assetCode: "USDT", amount: "10" } });
    assert.equal(faucet.status, 201);
    await waitFor("deposit notification", async () =>
      (await gateway("/notifications/unread-count", { token: ctx.token })).body.unreadCount > 0, 60_000);
    const statement = await gateway("/ledger/entries?assetCode=USDT&limit=1", { token: ctx.token });
    assert.equal(statement.status, 200);
    const balances = items((await gateway("/balances", { token: ctx.token })).body);
    const usdt = balances.find((balance) => balance.assetCode === "USDT");
    const latest = statement.body.items[0];
    if (latest?.balanceAfter) {
      assert.equal(Number(latest.balanceAfter.total), Number(usdt.total), "statement balance matches the account");
    }
    return `unread 0 -> >0 · statement head ${latest?.category ?? "?"} matches balance`;
  },

  /** M4-1 2FA, M4-4 KYC, M5-2 dual approval. Leaves 2FA disabled. */
  async security(ctx) {
    const enroll = await gateway("/auth/two-factor/enroll", { token: ctx.token, body: {} });
    assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
    const secret = enroll.body.secret;
    let token = ctx.token;
    const enable = await gateway("/auth/two-factor/enable", { token, body: { code: await freshTotp(secret) } });
    assert.equal(enable.status, 201);
    const recovery = enable.body.recoveryCodes;
    assert.equal(recovery.length, 8);
    try {
      assert.equal((await traderLogin()).status, 403, "login needs a code once 2FA is on");
      const withCode = await traderLogin(await freshTotp(secret));
      assert.equal(withCode.status, 201);
      token = withCode.body.token;
      assert.equal((await traderLogin(recovery[0])).status, 201, "recovery code works once");
      assert.equal((await traderLogin(recovery[0])).status, 403, "recovery code is single-use");

      const kyc = (await gateway("/auth/kyc", { token })).body;
      if (kyc.tier !== "L2") {
        const request = await gateway("/auth/kyc/requests", { token, body: { requestedTier: "L2", fullName: "Demo Trader", idNumber: "DEMO12345678" } });
        assert.equal(request.status, 201, JSON.stringify(request.body));
        const queue = items((await ops(ctx.opsToken, "/kyc/requests?status=pending")).body);
        const pending = queue.find((item) => item.userId === DEMO_TRADER.userId);
        assert.ok(pending, "KYC request reaches the ops queue");
        assert.equal((await ops(ctx.opsToken, `/kyc/requests/${pending.requestId}/approve`, { tier: "L2" })).status, 201);
      }
      const limits = (await gateway("/withdrawals/limits", { token })).body;
      assert.equal(limits.kycTier, "L2");
      const threshold = Number(limits.assets.find((asset) => asset.assetCode === "USDT").dualApprovalThreshold);

      const withdrawal = await gateway("/withdrawals/request", {
        token,
        headers: { "idempotency-key": randomUUID() },
        body: {
          ledgerAccountId: DEMO_TRADER.accountId,
          assetCode: "USDT",
          network: config.demoNetwork,
          toAddress: config.withdrawalAddress ?? DEMO_WITHDRAWAL_ADDRESS,
          amount: String(threshold + 1),
          fee: "1",
          twoFactorCode: await freshTotp(secret)
        }
      });
      assert.equal(withdrawal.status, 201, JSON.stringify(withdrawal.body));
      const id = withdrawal.body.withdrawalId;
      const first = await ops(ctx.opsToken, `/withdrawals/${id}/approve`, { reason: "e2e first" });
      assert.equal(first.body.reviewStatus, "pending_second_approval");
      const same = await ops(ctx.opsToken, `/withdrawals/${id}/approve`, { reason: "e2e same" });
      assert.equal(same.status, 409);
      assert.match(JSON.stringify(same.body), /WITHDRAWAL_SAME_APPROVER/);
      const reviewer = await opsLogin(DEMO_OPS_REVIEWER);
      const second = await ops(reviewer, `/withdrawals/${id}/approve`, { reason: "e2e second" });
      assert.equal(second.body.reviewStatus, "approved");
      await waitFor("dual-approved withdrawal confirmed", async () =>
        items((await gateway("/withdrawals?limit=5", { token })).body).some(
          (item) => item.withdrawalId === id && item.status === "confirmed"
        ), 90_000, 2_000);
      return "2FA login/recovery ok · KYC L2 · 1/2 → same-approver 409 → 2/2 confirmed";
    } finally {
      const disabled = await gateway("/auth/two-factor/disable", { token, body: { code: await freshTotp(secret) } });
      assert.equal(disabled.status, 201, "2FA is disabled again");
    }
  },

  /** M3-2: every fault-lab experiment, then recover-all. */
  async lab(ctx) {
    const t = ctx.opsToken;
    const pause = await ops(t, "/lab/settlement/pause", { durationSeconds: 60 });
    assert.equal(pause.body.pause.paused, true);
    const paused = await placeOrder(ctx.token, ctx.accountId, { market: config.demoMarket, price: await bestAsk(config.demoMarket) });
    await sleep(6_000);
    const unsettled = items(await fetchJson(`${SETTLEMENT}/api/v1/settlement/trades?orderId=${paused.body.orderId}`));
    assert.equal(unsettled.length, 0, "no settlement while the consumer is paused");
    assert.equal((await ops(t, "/lab/settlement/resume", {})).body.pause.paused, false);
    await waitSettled(paused.body.orderId);

    assert.equal((await ops(t, "/lab/custody/inject", {})).status, 201);
    const probe = (await ops(t, "/lab/custody/probe", { count: 3 })).body;
    assert.ok(probe.attempts.some((attempt) => attempt.circuitStateAfter === "open"), "circuit opens");
    assert.equal(probe.attempts.at(-1).outcome, "succeeded", "backup provider takes over");
    assert.equal((await ops(t, "/lab/custody/clear", {})).status, 201);

    const reorgsBefore = (await ops(t, "/lab/status")).body.chain.data.reorgCount ?? 0;
    const reorg = await ops(t, "/lab/chain/reorg", {});
    assert.equal(reorg.status, 201, JSON.stringify(reorg.body));
    assert.ok(reorg.body.reorg.depth > 0);
    assert.equal((await ops(t, "/lab/status")).body.chain.data.reorgCount, reorgsBefore + 1);
    // The indexer notices the replaced block hash on its next scan; acknowledging
    // then clears the reorg flag on its deposit cursor.
    await waitFor("indexer reorg flag", async () => {
      const ack = await ops(t, "/lab/indexer/reorg-acknowledge", {});
      return ack.status === 201 && (ack.body.clearedCursors ?? []).some((cursor) => cursor.observationType === "deposit");
    }, 30_000, 2_000);

    const reset = (await ops(t, "/lab/engine/reset", { market: config.demoMarket })).body;
    assert.ok(reset.anomalyCountAfter > 0, "a book-only reset leaves orphaned open orders");
    assert.equal((await ops(t, "/spot/ops/replay-engine", { market: config.demoMarket })).status, 201);
    const restart = (await ops(t, "/lab/engine/reset", { market: config.demoMarket, resetSequences: true })).body;
    assert.equal(restart.reset.healsAutomatically, true);
    await waitFor("engine self-heals after a simulated restart", async () => {
      const status = (await ops(t, `/lab/status?market=${config.demoMarket}`)).body;
      return status.engine?.overview?.data?.anomalyCount === 0;
    }, 20_000);
    const healed = await placeOrder(ctx.token, ctx.accountId, { market: config.demoMarket, price: await bestAsk(config.demoMarket) });
    await waitSettled(healed.body.orderId);

    assert.equal((await ops(t, "/lab/recover-all", {})).status, 201);
    return "settlement pause/resume · custody failover · reorg ack · engine reset + self-heal";
  },

  /**
   * A1–A3: emergency switches (asset / global withdrawal pause, API write
   * freeze), RBAC + reason + audit, P1/P2/P3 alerts, scheduled reconciliation
   * with order-vs-lock, and the reconciliation circuit breaker (lab drift).
   * Every switch is turned off again in `finally`.
   */
  async controls(ctx) {
    const t = ctx.opsToken;
    const breakerAsset = process.env.E2E_CONTROLS_BREAKER_ASSET ?? CONFIG_LISTED_MARKET.split("-")[0];
    const toAddress = config.withdrawalAddress ?? DEMO_WITHDRAWAL_ADDRESS;
    const setControl = (body, token = t) => ops(token, "/controls", body);
    const withdrawal = (assetCode, amount, fee) => ({
      ledgerAccountId: DEMO_TRADER.accountId,
      assetCode,
      network: config.demoNetwork,
      toAddress,
      amount,
      fee
    });
    const validate = (assetCode, amount = "1", fee = "1") =>
      gateway("/withdrawals/validate", { token: ctx.token, body: withdrawal(assetCode, amount, fee) });
    const codeOf = (result) => (JSON.stringify(result.body).match(/WITHDRAWALS_PAUSED|ASSET_WITHDRAWALS_PAUSED|API_WRITE_FROZEN|RECONCILIATION_NOT_CLEAN/) ?? [])[0];
    // Consumers cache switches for CONTROL_SWITCH_CACHE_MS (2s); poll instead of sleeping.
    const waitCode = (label, call, code) =>
      waitFor(label, async () => {
        const result = await call();
        return code ? (result.status === 409 && codeOf(result) === code ? result : null) : (codeOf(result) ? null : result);
      }, 15_000, 500);
    // The gateway guard and GET /system/controls share one cache, so this tells
    // exactly when the gateway enforces a change.
    const waitGateway = (label, predicate) =>
      waitFor(label, async () => predicate((await gateway("/system/controls")).body), 15_000, 300);
    const runReconciliation = async () => {
      const result = await ops(t, "/ledger/reconciliation/jobs/run", {});
      assert.equal(result.status, 201, `reconciliation run: ${JSON.stringify(result.body)}`);
      return result.body;
    };
    const cleanup = [];

    try {
      const initial = await ops(t, "/controls");
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      assert.equal(initial.body.state.withdrawalsPaused, null, "global withdrawals start open");
      assert.equal(initial.body.state.apiWriteFrozen, null, "API writes start open");
      assert.deepEqual(initial.body.state.assetWithdrawalPauses, [], "no asset starts paused");

      // RBAC + reason
      const reviewer = await opsLogin(DEMO_OPS_REVIEWER);
      assert.equal((await setControl({ scope: "api_write", enabled: true, reason: "e2e" }, reviewer)).status, 403, "ops_reviewer cannot switch");
      assert.equal((await setControl({ scope: "api_write", enabled: true })).status, 400, "a reason is required");

      // A1b: per-asset withdrawal pause
      cleanup.push(() => setControl({ scope: "withdrawals_asset", assetCode: "USDT", enabled: false, reason: "e2e cleanup" }));
      assert.equal((await setControl({ scope: "withdrawals_asset", assetCode: "USDT", enabled: true, reason: "e2e asset pause" })).status, 201);
      await waitCode("USDT withdrawals paused", () => validate("USDT"), "ASSET_WITHDRAWALS_PAUSED");
      assert.equal(codeOf(await validate("ETH", "0.01", "0.001")), undefined, "other assets are not paused");
      const publicControls = await gateway("/system/controls");
      assert.equal(publicControls.status, 200);
      assert.ok(publicControls.body.pausedWithdrawalAssets.includes("USDT"), "trader-web sees the asset pause");
      assert.equal((await setControl({ scope: "withdrawals_asset", assetCode: "USDT", enabled: false, reason: "e2e resume" })).status, 201);
      await waitCode("USDT withdrawals open again", () => validate("USDT"));

      // A1a: global pause also holds queued withdrawals (approval / broadcast)
      const queued = await gateway("/withdrawals/request", {
        token: ctx.token,
        headers: { "idempotency-key": randomUUID() },
        body: withdrawal("USDT", "1", "1")
      });
      assert.equal(queued.status, 201, `queued withdrawal: ${JSON.stringify(queued.body)}`);
      cleanup.push(() => setControl({ scope: "withdrawals_global", enabled: false, reason: "e2e cleanup" }));
      assert.equal((await setControl({ scope: "withdrawals_global", enabled: true, reason: "e2e global pause" })).status, 201);
      await waitCode("all withdrawals paused", () => validate("ETH", "0.01", "0.001"), "WITHDRAWALS_PAUSED");
      // wallet-service has its own switch cache (2s): never approve before it has expired.
      await sleep(2_500);
      const approve = await ops(t, `/withdrawals/${queued.body.withdrawalId}/approve`, { reason: "e2e" });
      assert.equal(approve.status, 409, `approval is held while paused: ${JSON.stringify(approve.body)}`);
      assert.equal(codeOf(approve), "WITHDRAWALS_PAUSED");
      const rejected = await ops(t, `/withdrawals/${queued.body.withdrawalId}/reject`, { reason: "e2e: paused" });
      assert.equal(rejected.status, 201, `reject still works while paused: ${JSON.stringify(rejected.body)}`);

      // A3: a switch that is on shows up as a P2 alert
      const alerts = await ops(t, "/alerts");
      assert.equal(alerts.status, 200);
      assert.ok(alerts.body.countsBySeverity, "alerts carry counts per level");
      assert.ok(
        alerts.body.items.some((item) => item.code === "withdrawals_paused" && item.severity === "P2"),
        `global pause is a P2 alert: ${JSON.stringify(alerts.body.items)}`
      );
      assert.equal((await setControl({ scope: "withdrawals_global", enabled: false, reason: "e2e resume" })).status, 201);
      await waitCode("withdrawals open again", () => validate("ETH", "0.01", "0.001"));

      // A1c: API write freeze — new orders / withdrawal requests 409, cancels still work
      const market = config.demoMarket;
      await bestAsk(market); // makers are quoting
      const depth = await fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${market}`);
      const restPrice = (Number(depth.bids[0].price) * 0.95).toFixed(2);
      const resting = await placeOrder(ctx.token, ctx.accountId, { market, price: restPrice, timeInForce: "gtc", quantity: "0.01" });
      assert.equal(resting.body.status, "accepted", JSON.stringify(resting.body));
      cleanup.push(() => setControl({ scope: "api_write", enabled: false, reason: "e2e cleanup" }));
      assert.equal((await setControl({ scope: "api_write", enabled: true, reason: "e2e read-only drill" })).status, 201);
      await waitGateway("gateway read-only mode", (controls) => controls.apiWriteFrozen === true);
      const frozenOrder = await placeOrder(ctx.token, ctx.accountId, { market, price: restPrice, timeInForce: "gtc", quantity: "0.01" });
      assert.equal(frozenOrder.status, 409, JSON.stringify(frozenOrder.body));
      assert.equal(codeOf(frozenOrder), "API_WRITE_FROZEN");
      const frozenWithdrawal = await gateway("/withdrawals/request", {
        token: ctx.token,
        headers: { "idempotency-key": randomUUID() },
        body: withdrawal("USDT", "1", "1")
      });
      assert.equal(codeOf(frozenWithdrawal), "API_WRITE_FROZEN", "withdrawal requests are frozen too");
      const cancel = await gateway(`/orders/${resting.body.orderId}/cancel`, { token: ctx.token, body: {} });
      assert.equal(cancel.body.status, "cancelled", "cancels still work in read-only mode");
      assert.equal((await setControl({ scope: "api_write", enabled: false, reason: "e2e resume" })).status, 201);
      await waitGateway("gateway accepts writes again", (controls) => controls.apiWriteFrozen === false);
      await sleep(1_500); // risk-service's own switch cache (1s) behind the gateway
      const after = await placeOrder(ctx.token, ctx.accountId, { market, price: await bestAsk(market) });
      assert.equal(after.status, 201, `orders accepted again: ${JSON.stringify(after.body)}`);
      await waitSettled(after.body.orderId);

      // A2: scheduled reconciliation (balance + order-vs-lock) is healthy
      const runs = await ops(t, "/ledger/reconciliation/runs?limit=5");
      assert.equal(runs.status, 200);
      assert.ok(runs.body.job.enabled && runs.body.job.intervalSeconds > 0, `scheduled reconciliation is on: ${JSON.stringify(runs.body.job)}`);
      const healthy = await waitFor("a clean reconciliation run", async () => {
        const run = await runReconciliation();
        return run.balance?.mismatchCount === 0 && run.orderLock?.mismatchCount === 0 && run.breaker.trips.length === 0 ? run : null;
      }, 30_000, 3_000);
      assert.ok(healthy.orderLock.scannedOrders > 0, "order-vs-lock compared real orders");

      // A2c: inject a ledger drift on the lab account → breaker pauses the asset (P1)
      cleanup.push(async () => {
        await ops(t, "/lab/reconciliation/clear", {});
        await runReconciliation();
        await setControl({ scope: "withdrawals_asset", assetCode: breakerAsset, enabled: false, reason: "e2e cleanup" });
      });
      const drift = await ops(t, "/lab/reconciliation/drift", { assetCode: breakerAsset, amount: "1" });
      assert.equal(drift.status, 201, JSON.stringify(drift.body));
      // A run already in progress is joined, so retry until one has seen the drift.
      const tripped = await waitFor("a reconciliation run that sees the drift", async () => {
        const run = await runReconciliation();
        return run.status === "mismatch" ? run : null;
      }, 30_000, 1_000);
      assert.ok(
        tripped.breaker.actions.some((action) => action.assetCode === breakerAsset && ["paused", "already_paused"].includes(action.outcome)),
        `breaker paused ${breakerAsset}: ${JSON.stringify(tripped.breaker)}`
      );
      const breakerState = await ops(t, "/controls");
      const pause = breakerState.body.state.assetWithdrawalPauses.find((entry) => entry.assetCode === breakerAsset);
      assert.equal(pause?.source, "automatic", "the pause is marked automatic");
      await waitCode(`${breakerAsset} withdrawals paused by the breaker`, () => validate(breakerAsset, "1", "0.01"), "ASSET_WITHDRAWALS_PAUSED");
      const p1 = await ops(t, "/alerts");
      assert.ok(
        p1.body.items.some((item) => item.code === "RECONCILIATION_BREAKER_TRIPPED" && item.severity === "P1"),
        "breaker raises a P1 alert"
      );
      const early = await setControl({ scope: "withdrawals_asset", assetCode: breakerAsset, enabled: false, reason: "too early" });
      assert.equal(early.status, 409);
      assert.equal(codeOf(early), "RECONCILIATION_NOT_CLEAN", "resume needs a clean run first");

      assert.equal((await ops(t, "/lab/reconciliation/clear", {})).status, 201);
      const clean = await waitFor("a clean run after the drift is removed", async () => {
        const run = await runReconciliation();
        return run.balance?.mismatchCount === 0 ? run : null;
      }, 30_000, 1_000);
      assert.equal(clean.balance.mismatchCount, 0, "clean after the drift is removed");
      const resumed = await setControl({ scope: "withdrawals_asset", assetCode: breakerAsset, enabled: false, reason: "e2e: drift removed, run clean" });
      assert.equal(resumed.status, 201, JSON.stringify(resumed.body));

      const audit = await ops(t, "/audit-logs/actions?limit=100");
      const actions = items(audit.body).map((item) => item.action);
      for (const action of ["controls.withdrawals_asset.enable", "controls.withdrawals_global.enable", "controls.api_write.disable", "fault_lab.reconciliation.inject_drift"]) {
        assert.ok(actions.includes(action), `audit has ${action}`);
      }
      return `asset/global pause 409 · approval held · read-only 409 + cancel ok · recon ok (${healthy.orderLock.scannedOrders} orders) · drift → ${breakerAsset} auto-paused P1 → resumed`;
    } finally {
      for (const step of cleanup.reverse()) {
        await Promise.resolve()
          .then(step)
          .catch(() => undefined);
      }
    }
  }
};

// ---------------------------------------------------------------------------

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(sections);
for (const name of names) {
  assert.ok(sections[name], `unknown section ${name}`);
}

const login = await traderLogin();
assert.equal(login.status, 201, `demo trader login: ${JSON.stringify(login.body)}`);
const account = await gateway("/accounts/spot", { token: login.body.token });
const ctx = { token: login.body.token, accountId: account.body.accountId, opsToken: await opsLogin(DEMO_OPS) };

let failed = false;
// Print each result as soon as it is known so a later crash cannot hide it.
const report = (result) => {
  failed ||= !result.ok;
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(14)} ${result.seconds.toFixed(1).padStart(5)}s  ${result.detail}`);
};

for (const name of names) {
  const startedAt = Date.now();
  try {
    const detail = await sections[name](ctx);
    report({ name, ok: true, detail, seconds: (Date.now() - startedAt) / 1000 });
  } catch (error) {
    report({ name, ok: false, detail: error instanceof Error ? error.message : String(error), seconds: (Date.now() - startedAt) / 1000 });
  }
}

try {
  const mismatches = await reconciliationMismatches(ctx.opsToken);
  report({ name: "reconciliation", ok: mismatches === 0, detail: `${mismatches} mismatches`, seconds: 0 });
} catch (error) {
  report({ name: "reconciliation", ok: false, detail: error instanceof Error ? error.message : String(error), seconds: 0 });
}
process.exit(failed ? 1 : 0);
