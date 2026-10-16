// End-to-end checks for the platform features against a running, seeded stack
// (`pnpm demo:up`). Every check talks to real services; nothing is mocked.
//
//   node ./scripts/verify-feature-e2e.mjs [section...]
//
// Sections: apikey, websocket, fees, sol, notifications, security, lab, hardening, matching, risk-security,
// reserves, fees-surveillance, controls.
// Without arguments all sections run. The demo trader is restored afterwards
// (2FA disabled, faults recovered); KYC tier and balances change, which
// `pnpm demo:prepare` resets.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  DEMO_MAKERS,
  DEMO_OPENING_BALANCE_ACCOUNT_ID,
  DEMO_OPS,
  DEMO_OPS_REVIEWER,
  DEMO_TRADER,
  DEMO_WITHDRAWAL_ADDRESS,
  fetchJson,
  generateTotpCode,
  loadDemoConfig,
  setDemoMakersPaused
} from "./mvp-demo-lib.mjs";

const config = loadDemoConfig();
const TRADER_WEB = process.env.TRADER_WEB_BASE_URL ?? "http://127.0.0.1:3013";
const OPS = `${process.env.OPS_CONSOLE_BASE_URL ?? "http://127.0.0.1:3006"}/api/v1/ops`;
const GATEWAY = `${config.gatewayBaseUrl}/api/v1/gateway`;
const SETTLEMENT = config.settlementBaseUrl;

// The market listed purely through config/markets.json (acceptance target).
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

// A crossing IOC buy at the best ask can miss when the makers move the book in
// between; retry with a fresh ask until it fills (or return the last response).
async function placeFilledOrder(token, accountId, order) {
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await placeOrder(token, accountId, { ...order, price: await bestAsk(order.market) });
    if (last.status !== 201 || last.body.status !== "rejected" || last.body.rejectedReason !== "no_executable_liquidity") {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
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
  /** keyId + secret, nonce anti-replay, scopes, revocation. */
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

  /** Origin allow-list and per-connection rate limiting. */
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

  /** dual fees and a balanced T-account view of a real trade. */
  async fees(ctx) {
    const market = config.demoMarket;
    const order = await placeFilledOrder(ctx.token, ctx.accountId, { market });
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

  /** SOL-USDT from config — trading, deposit, halt / resume. */
  async sol(ctx) {
    const runtime = await fetchJson(`${TRADER_WEB}/api/config`);
    assert.ok(runtime.markets.some((item) => item.market === CONFIG_LISTED_MARKET), `${CONFIG_LISTED_MARKET} is configured`);
    const order = await placeFilledOrder(ctx.token, ctx.accountId, { market: CONFIG_LISTED_MARKET, quantity: "0.1" });
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
    const after = await placeFilledOrder(ctx.token, ctx.accountId, { market: CONFIG_LISTED_MARKET, quantity: "0.1" });
    assert.equal(after.status, 201, "orders accepted again after resume");
    return "SOL fill settled · SOL deposit credited · halt 409 / cancel ok / resume ok";
  },

  /** notification read state and the ledger statement. */
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

  /** 2FA, KYC, dual approval. Leaves 2FA disabled. */
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

  /** every fault-lab experiment, then recover-all. */
  async lab(ctx) {
    const t = ctx.opsToken;
    const pause = await ops(t, "/lab/settlement/pause", { durationSeconds: 60 });
    assert.equal(pause.body.pause.paused, true);
    const paused = await placeFilledOrder(ctx.token, ctx.accountId, { market: config.demoMarket });
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
    const healed = await placeFilledOrder(ctx.token, ctx.accountId, { market: config.demoMarket });
    await waitSettled(healed.body.orderId);

    assert.equal((await ops(t, "/lab/recover-all", {})).status, 201);
    return "settlement pause/resume · custody failover · reorg ack · engine reset + self-heal";
  },

  /** Hardening: internal auth on custody/indexer, loopback binding, ledger key races, XFF trust. */
  async hardening() {
    const custody = process.env.DEMO_CUSTODY_URL ?? "http://127.0.0.1:3004";
    for (const url of [`${custody}/api/v1/custody/providers/health`, `${config.indexerBaseUrl}/api/v1/indexer/ops/overview`]) {
      assert.equal((await http(url)).status, 401, `unsigned ${url} is rejected`);
      await fetchJson(url); // signed by mvp-demo-lib (caller demo-scripts)
    }

    // Edge and internal services listen on loopback only (default bind host).
    const { networkInterfaces } = await import("node:os");
    const { createConnection } = await import("node:net");
    const lanAddress = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal)?.address;
    let bindDetail = "no LAN address, bind check skipped";
    if (lanAddress) {
      for (const port of [3003, 3004, 3006, 3007, 3012, 3013]) {
        const reachable = await new Promise((resolve) => {
          const socket = createConnection({ host: lanAddress, port });
          const done = (value) => { socket.destroy(); resolve(value); };
          socket.setTimeout(1_000, () => done(false));
          socket.once("connect", () => done(true));
          socket.once("error", () => done(false));
        });
        assert.equal(reachable, false, `port ${port} must not listen on ${lanAddress}`);
      }
      bindDetail = `loopback-only on ${lanAddress}`;
    }

    // Same idempotency key: identical concurrent posts replay one journal; a
    // different payload is a 409, never a 500.
    const key = `e2e-hardening:${randomUUID()}`;
    const journal = (amount) => ({
      method: "POST",
      body: JSON.stringify({
        businessType: "e2e_hardening",
        businessId: key,
        idempotencyKey: key,
        traceId: key,
        entries: [
          { accountId: DEMO_OPENING_BALANCE_ACCOUNT_ID, assetCode: "USDT", direction: "debit", amount, referenceType: "e2e_hardening", referenceId: key },
          { accountId: DEMO_OPENING_BALANCE_ACCOUNT_ID, assetCode: "USDT", direction: "credit", amount, referenceType: "e2e_hardening", referenceId: key }
        ]
      })
    });
    const journals = await Promise.all([1, 2, 3].map(() => fetchJson(`${config.ledgerBaseUrl}/api/v1/ledger/journals`, journal("1"))));
    assert.equal(new Set(journals.map((item) => item.journalId)).size, 1, "concurrent identical journals replay one result");
    const conflict = await fetchJson(`${config.ledgerBaseUrl}/api/v1/ledger/journals`, journal("2")).catch((error) => error);
    assert.equal(conflict.httpStatus, 409, `different payload: ${conflict.message}`);

    // Without GATEWAY_TRUST_PROXY a spoofed X-Forwarded-For does not get a fresh bucket.
    const attempt = (ip) => http(`${GATEWAY}/auth/sessions`, {
      headers: { "x-forwarded-for": ip },
      body: { email: `xff-${randomUUID()}@example.invalid`, password: "not-the-password" }
    });
    let sameBucket = false;
    for (let round = 0; round < 2 && !sameBucket; round += 1) {
      const first = Number((await attempt("198.51.100.10")).headers.get("x-rate-limit-remaining"));
      const second = Number((await attempt("198.51.100.20")).headers.get("x-rate-limit-remaining"));
      sameBucket = second < first;
    }
    assert.ok(sameBucket, "X-Forwarded-For must not select the rate-limit bucket by default");
    return `custody/indexer unsigned 401 · ${bindDetail} · journal replay + 409 · XFF ignored`;
  },

  /** Matching enhancements: post-only, self-trade prevention, stop orders. */
  async matching(ctx) {
    const market = config.demoMarket;
    const getOrder = async (orderId) => (await gateway(`/orders/${orderId}`, { token: ctx.token })).body;
    const depth = async () => fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${market}`);
    const cancel = async (orderId) => gateway(`/orders/${orderId}/cancel`, { token: ctx.token, body: {} });

    // Malformed options are rejected before they reach risk / the engine.
    const badStp = await placeOrder(ctx.token, ctx.accountId, { market, price: await bestAsk(market), stpMode: "nope" });
    assert.equal(badStp.status, 400, JSON.stringify(badStp.body));
    const noTrigger = await placeOrder(ctx.token, ctx.accountId, { market, type: "stop_limit", price: await bestAsk(market), timeInForce: "gtc" });
    assert.equal(noTrigger.status, 400, JSON.stringify(noTrigger.body));

    // Own some base asset for the sell-side checks.
    const bought = await placeFilledOrder(ctx.token, ctx.accountId, { market, quantity: "0.05" });
    assert.equal(bought.body.status, "filled", JSON.stringify(bought.body));
    await waitSettled(bought.body.orderId);

    // Freeze the maker ladder so the book cannot move under the STP checks.
    await setDemoMakersPaused(config, true);
    const created = [];
    try {
      await sleep(1_500);
      // 1. Post-only that would take liquidity is rejected and fully released.
      const takingPostOnly = await placeOrder(ctx.token, ctx.accountId, {
        market, price: await bestAsk(market), timeInForce: "gtc", postOnly: true
      });
      assert.equal(takingPostOnly.status, 201, JSON.stringify(takingPostOnly.body));
      assert.equal(takingPostOnly.body.status, "rejected");
      assert.equal(takingPostOnly.body.rejectedReason, "post_only_would_take");
      assert.equal(takingPostOnly.body.filledQuantity, "0");

      // 2. Post-only inside the spread rests as the best bid.
      const book = await depth();
      const bid = Number(book.bids[0].price);
      const ask = Number(book.asks[0].price);
      assert.ok(ask - bid >= 0.02, `spread ${bid}/${ask} leaves room inside`);
      const inside = (Math.floor(((bid + ask) / 2) * 100) / 100).toFixed(2);
      const ownBid = await placeOrder(ctx.token, ctx.accountId, { market, price: inside, timeInForce: "gtc", postOnly: true });
      assert.equal(ownBid.body.status, "accepted", JSON.stringify(ownBid.body));
      assert.equal(ownBid.body.postOnly, true);
      created.push(ownBid.body.orderId);

      // 3. STP expire_taker (default): a sell that would hit the own bid expires.
      const selfSell = await placeOrder(ctx.token, ctx.accountId, { market, side: "sell", price: inside, timeInForce: "ioc" });
      assert.equal(selfSell.body.status, "rejected", JSON.stringify(selfSell.body));
      assert.equal(selfSell.body.rejectedReason, "stp_expired_taker");
      assert.equal((await getOrder(ownBid.body.orderId)).status, "accepted", "own resting bid is kept");

      // 4. STP expire_maker: the own bid is cancelled, the sell keeps going and rests.
      const makerExpiry = await placeOrder(ctx.token, ctx.accountId, {
        market, side: "sell", price: inside, timeInForce: "gtc", stpMode: "expire_maker"
      });
      assert.equal(makerExpiry.body.status, "accepted", JSON.stringify(makerExpiry.body));
      created.push(makerExpiry.body.orderId);
      const expiredBid = await getOrder(ownBid.body.orderId);
      assert.equal(expiredBid.status, "cancelled");
      assert.equal(expiredBid.rejectedReason, "stp_expired_maker");
      assert.equal((await cancel(makerExpiry.body.orderId)).body.status, "cancelled");
    } finally {
      for (const orderId of created) {
        await cancel(orderId).catch(() => undefined);
      }
      await setDemoMakersPaused(config, false);
    }

    // 5. Stop-limit far above the market waits in pending_trigger; cancel releases it.
    const askNow = Number(await bestAsk(market));
    const farTrigger = (askNow * 1.1).toFixed(2);
    const waiting = await placeOrder(ctx.token, ctx.accountId, {
      market, type: "stop_limit", timeInForce: "gtc", triggerPrice: farTrigger, price: (askNow * 1.11).toFixed(2)
    });
    assert.equal(waiting.status, 201, JSON.stringify(waiting.body));
    assert.equal(waiting.body.status, "pending_trigger");
    assert.equal(Number(waiting.body.triggerPrice), Number(farTrigger));
    const openStops = items((await gateway(`/orders?market=${market}&status=pending_trigger`, { token: ctx.token })).body);
    assert.ok(openStops.some((order) => order.orderId === waiting.body.orderId), "listed as pending_trigger");
    const cancelledStop = await cancel(waiting.body.orderId);
    assert.equal(cancelledStop.body.status, "cancelled");

    // 6. Stop-market sell whose trigger is already above the last price fires on
    //    the next trigger pass and executes as a market order.
    const firing = await placeOrder(ctx.token, ctx.accountId, {
      market, side: "sell", type: "stop_market", timeInForce: "ioc", triggerPrice: (askNow * 1.05).toFixed(2), price: undefined
    });
    assert.equal(firing.body.status, "pending_trigger", JSON.stringify(firing.body));
    const fired = await waitFor("stop-market trigger", async () => {
      const order = await getOrder(firing.body.orderId);
      return order.status !== "pending_trigger" && order.status !== "pending_risk" ? order : null;
    }, 20_000, 500);
    assert.ok(fired.triggeredAt, "triggeredAt is recorded");
    assert.equal(fired.status, "filled", JSON.stringify(fired));
    await waitSettled(firing.body.orderId);
    return "post-only reject/rest · STP expire_taker + expire_maker · stop pending/cancel · stop-market fired + settled";
  },

  /**
   * Withdrawal address risk (simplified KYT) and device / login security:
   * scoring, blocked addresses, blacklist sweep, new-device notice, device
   * revoke, failed-login lock. Assumes 2FA is off for the demo trader.
   */
  async "risk-security"(ctx) {
    const SANCTIONED = "0xbad0000000000000000000000000000000000001"; // seeded in wallet sql/010
    const MIXER = "0xdeadbeef00000000000000000000000000000001"; // demo label set
    const withdrawBody = (toAddress, amount = "10") => ({
      ledgerAccountId: ctx.accountId,
      assetCode: "USDT",
      network: config.demoNetwork,
      toAddress,
      amount,
      fee: "1"
    });

    // 1. KYT scoring at validate time.
    const safe = await gateway("/withdrawals/validate", { token: ctx.token, body: withdrawBody(config.withdrawalAddress ?? DEMO_WITHDRAWAL_ADDRESS) });
    assert.equal(safe.status, 201, JSON.stringify(safe.body));
    assert.equal(safe.body.risk?.level, "low", "the demo whitelisted address scores low");
    const mixer = await gateway("/withdrawals/validate", { token: ctx.token, body: withdrawBody(MIXER) });
    assert.equal(mixer.status, 201, JSON.stringify(mixer.body));
    assert.equal(mixer.body.risk?.level, "high", "mixer-labelled address scores high");
    assert.equal(mixer.body.appliedRules?.requiredApprovals, 2, "high risk needs dual approval regardless of amount");
    const blockedCheck = await gateway("/withdrawals/validate", { token: ctx.token, body: withdrawBody(SANCTIONED) });
    assert.equal(blockedCheck.status, 403);
    assert.match(JSON.stringify(blockedCheck.body), /WITHDRAWAL_ADDRESS_BLOCKED/);

    // 2. A real request to a blacklisted address is refused and kept as an auto-rejected withdrawal.
    const blocked = await gateway("/withdrawals/request", {
      token: ctx.token,
      headers: { "idempotency-key": randomUUID() },
      body: withdrawBody(SANCTIONED)
    });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    const blockedRecord = await waitFor("blocked withdrawal record", async () =>
      items((await gateway(`/withdrawals?toAddress=${SANCTIONED}&limit=5`, { token: ctx.token })).body).find(
        (item) => item.riskLevel === "blocked" && item.status === "rejected"
      ), 10_000);
    assert.equal(Number(blockedRecord.frozenAmount), 0, "nothing was frozen for a blocked request");

    // 3. Blacklisting an address sweeps pending withdrawals to it (funds released, user notified).
    const fresh = `0x${randomBytes(20).toString("hex")}`;
    const pending = await gateway("/withdrawals/request", {
      token: ctx.token,
      headers: { "idempotency-key": randomUUID() },
      body: withdrawBody(fresh)
    });
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    assert.equal(pending.body.riskLevel, "low");
    const added = await ops(ctx.opsToken, "/risk/address-blacklist", { network: config.demoNetwork, address: fresh, category: "scam", reason: "e2e risk-security" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual(added.body.autoRejectedWithdrawalIds, [pending.body.withdrawalId]);
    const swept = await waitFor("swept withdrawal rejected", async () =>
      items((await gateway("/withdrawals?limit=10", { token: ctx.token })).body).find(
        (item) => item.withdrawalId === pending.body.withdrawalId && item.status === "rejected"
      ), 10_000);
    assert.equal(swept.riskLevel, "blocked");
    const blockedFilter = await ops(ctx.opsToken, `/withdrawals?riskLevel=blocked&userId=${DEMO_TRADER.userId}&limit=50`);
    assert.ok(items(blockedFilter.body).some((item) => item.withdrawalId === pending.body.withdrawalId), "ops filter by risk level");
    const removed = await ops(ctx.opsToken, `/risk/address-blacklist/${added.body.entry.entryId}/remove`, { reason: "e2e cleanup" });
    assert.equal(removed.body.status, "removed");
    const audit = await ops(ctx.opsToken, "/audit-logs/actions?action=risk.blacklist.add&limit=5");
    if (audit.status === 200) {
      assert.ok(items(audit.body).some((item) => item.targetId === `${config.demoNetwork}:${fresh}`), "blacklist add is audited");
    }

    // 4. New device: login with an unseen device id -> flagged + inbox notice; then revoke it.
    const deviceId = `e2e_${randomBytes(8).toString("hex")}`;
    const runtime = await fetchJson(`${TRADER_WEB}/api/config`);
    const account = runtime.demo?.account ?? { email: DEMO_TRADER.email, password: DEMO_TRADER.password };
    const newDevice = await gateway("/auth/sessions", { body: { ...account, deviceId } });
    assert.equal(newDevice.status, 201, JSON.stringify(newDevice.body));
    assert.equal(newDevice.body.device?.isNewDevice, true, "unseen device is flagged as new");
    await waitFor("new-device notification", async () =>
      items((await gateway("/notifications?eventType=security.new_device_login&limit=10", { token: ctx.token })).body).some(
        (item) => item.payload?.deviceId === deviceId
      ), 15_000);
    const devices = await gateway("/auth/devices", { token: ctx.token });
    assert.ok(items(devices.body).some((item) => item.deviceId === deviceId && item.flaggedNew), "device list shows the new device");
    const history = await gateway("/auth/login-events?limit=5", { token: ctx.token });
    assert.ok(items(history.body).some((item) => item.deviceId === deviceId && item.outcome === "success" && item.isNewDevice));
    const opsDevices = await ops(ctx.opsToken, `/users/${DEMO_TRADER.userId}/devices`);
    assert.ok(items(opsDevices.body).some((item) => item.deviceId === deviceId), "ops user detail lists devices");
    assert.equal((await ops(ctx.opsToken, `/users/${DEMO_TRADER.userId}/login-events?limit=5`)).status, 200);
    const revoked = await gateway(`/auth/devices/${deviceId}/revoke`, { token: ctx.token, body: {} });
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    assert.ok(revoked.body.revokedSessionCount >= 1);
    assert.equal((await gateway("/auth/me", { token: newDevice.body.token })).status, 401, "revoked device session is dead");
    assert.equal((await gateway("/auth/me", { token: ctx.token })).status, 200, "other devices stay signed in");

    // 5. Failed-login lock on a throwaway account (default 5 failures / 5 minutes).
    const email = `e2e-lock-${Date.now()}@example.com`;
    const password = "E2eLockPass123!";
    const registered = await gateway("/auth/register", { body: { email, password, displayName: "E2E Lock" } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await gateway("/auth/sessions", { body: { email, password: "wrong-password" } })).status, 401);
    }
    const locked = await gateway("/auth/sessions", { body: { email, password } });
    assert.equal(locked.status, 429, JSON.stringify(locked.body));
    assert.match(JSON.stringify(locked.body), /LOGIN_TEMPORARILY_LOCKED/);

    return "whitelisted low · mixer high (2 approvals) · blacklisted 403 + auto-rejected · sweep releases pending · new device notified + revoked · 5 failures lock 429";
  },

  /** Custody layering: sweep, hot -> cold approval, wallet-vs-ledger reconciliation, proof of reserves. */
  async reserves(ctx) {
    const t = ctx.opsToken;
    const treasuryNumber = (rows, assetCode, field) => Number(rows.find((row) => row.assetCode === assetCode)?.[field] ?? NaN);

    // 1. A faucet deposit is credited, then swept from the deposit address into the hot wallet.
    const faucet = await http(`${TRADER_WEB}/api/demo/faucet`, { token: ctx.token, body: { assetCode: "USDT", amount: "25" } });
    assert.equal(faucet.status, 201, JSON.stringify(faucet.body));
    const deposit = await waitFor("USDT faucet deposit credited", async () =>
      items((await gateway("/deposits?limit=10", { token: ctx.token })).body).find(
        (item) => item.txHash === faucet.body.txHash && item.status === "credited"
      ), 60_000);
    const sweepRun = await ops(t, "/treasury/sweeps/run", {});
    assert.equal(sweepRun.status, 201, JSON.stringify(sweepRun.body));
    const sweep = await waitFor("sweep of the deposit confirmed", async () => {
      const sweeps = items((await ops(t, "/treasury/transfers?kind=sweep&limit=50")).body).filter(
        (item) => item.fromAddress === faucet.body.address
      );
      for (const candidate of sweeps) {
        const detail = (await ops(t, `/treasury/transfers/${candidate.transferId}`)).body;
        if ((detail.sweptDepositIds ?? []).includes(deposit.depositId)) {
          if (detail.status === "failed") {
            // The deposit is released and swept again by the next run.
            await ops(t, "/treasury/sweeps/run", {});
            return null;
          }
          return detail.status === "confirmed" ? detail : null;
        }
      }
      return null;
    }, 90_000, 2_000);
    assert.equal(sweep.toWallet, "hot");

    // 2. hot -> cold rebalance: the proposer cannot approve, a second operator can.
    const before = (await ops(t, "/treasury/overview")).body;
    const coldBefore = treasuryNumber(before.holdings, "USDT", "cold");
    const proposal = await ops(t, "/treasury/transfers", { kind: "rebalance_to_cold", assetCode: "USDT", amount: "100", reason: "e2e drill" });
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
    assert.equal(proposal.body.status, "proposed");
    const same = await ops(t, `/treasury/transfers/${proposal.body.transferId}/approve`, { note: "self" });
    assert.equal(same.status, 409, JSON.stringify(same.body));
    assert.match(JSON.stringify(same.body), /TREASURY_SAME_APPROVER/);
    const reviewer = await opsLogin(DEMO_OPS_REVIEWER);
    const approved = await ops(reviewer, `/treasury/transfers/${proposal.body.transferId}/approve`, { note: "e2e" });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "broadcasted");
    await waitFor("rebalance confirmed on the demo chain", async () =>
      (await ops(t, `/treasury/transfers/${proposal.body.transferId}`)).body.status === "confirmed", 60_000, 2_000);
    const after = (await ops(t, "/treasury/overview")).body;
    assert.ok(treasuryNumber(after.holdings, "USDT", "cold") >= coldBefore + 100, "cold wallet received the rebalance");

    // 3. Wallet-vs-ledger: every asset covered (the demo reserve keeper backs opening-balance seeding).
    const reconciliation = await waitFor("treasury reconciliation covered", async () => {
      const report = (await ops(t, "/treasury/reconciliation")).body;
      return report?.status === "covered" ? report : null;
    }, 45_000, 3_000);
    const usdt = reconciliation.items.find((item) => item.assetCode === "USDT");
    assert.ok(Number(usdt.reserveRatio) >= 1, `USDT reserve ratio ${usdt.reserveRatio}`);
    assert.equal(await reconciliationMismatches(t), 0, "ledger reconciliation is untouched");

    // 4. Proof of reserves: the trader verifies their own leaf; nobody else's data is exposed.
    const snapshot = await ops(t, "/treasury/proof-of-reserves/snapshots", {});
    assert.equal(snapshot.status, 201, JSON.stringify(snapshot.body));
    const por = await gateway("/proof-of-reserves", { token: ctx.token });
    assert.equal(por.status, 200, JSON.stringify(por.body));
    assert.equal(por.body.available, true);
    assert.equal(por.body.snapshot.merkleRoot, snapshot.body.merkleRoot);
    assert.equal(por.body.included, true, "the demo trader is a leaf");
    const sha = (message) => createHash("sha256").update(message, "utf8").digest("hex");
    const leaf = por.body.leaf;
    const canonical = Object.entries(leaf.balances)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([asset, amount]) => `${asset}=${amount}`)
      .join(",");
    assert.equal(sha(`por-user:v1|${DEMO_TRADER.userId}|${leaf.nonce}`), leaf.userHash);
    assert.equal(sha(`por-leaf:v1|${leaf.userHash}|${canonical}`), leaf.leafHash);
    const root = por.body.proof.reduce(
      (current, step) => sha(step.position === "left" ? `por-node:v1|${step.hash}|${current}` : `por-node:v1|${current}|${step.hash}`),
      leaf.leafHash
    );
    assert.equal(root, snapshot.body.merkleRoot, "Merkle path leads to the published root");
    const serialized = JSON.stringify(por.body);
    for (const maker of Object.values(DEMO_MAKERS)) {
      assert.ok(!serialized.includes(maker.userId) && !serialized.includes(maker.accountId), "other users are not exposed");
    }
    return `sweep ${sweep.transferId.slice(0, 8)} confirmed · hot→cold same-approver 409 → reviewer approved · reserves covered (USDT ${usdt.reserveRatio}) · PoR root ${root.slice(0, 10)} verified (${snapshot.body.leafCount} leaves)`;
  },

  /** VIP fee tiers (resolution, ops override, recorded rate) + market surveillance alerts. */
  async "fees-surveillance"(ctx) {
    const market = config.demoMarket;
    const runtime = await fetchJson(`${TRADER_WEB}/api/config`);
    const definition = runtime.markets.find((item) => item.market === market);
    assert.ok(definition, `${market} is configured`);
    const userId = DEMO_TRADER.userId;
    const sameRate = (left, right) => Math.abs(Number(left) - Number(right)) < 1e-12;

    // 1. Own tier via the gateway: resolved from 30-day volume, VIP0 = market defaults.
    const tier = await gateway("/fees/tier", { token: ctx.token });
    assert.equal(tier.status, 200, JSON.stringify(tier.body));
    assert.equal(tier.body.source, "volume");
    assert.ok(sameRate(tier.body.tiers[0].takerFeeRate, definition.takerFeeRate), "VIP0 taker = market default");
    assert.ok(sameRate(tier.body.tiers[0].makerFeeRate, definition.makerFeeRate), "VIP0 maker = market default");
    assert.equal(tier.body.override?.note, undefined, "ops note is not exposed to the customer");
    const ownRate = tier.body.markets.find((item) => item.market === market).takerFeeRate;

    // 2. A taker fill records the resolved tier + rate on the trade and the settlement.
    const first = await placeFilledOrder(ctx.token, ctx.accountId, { market });
    assert.equal(first.body.status, "filled", JSON.stringify(first.body));
    const [firstSettlement] = await waitSettled(first.body.orderId);
    assert.equal(firstSettlement.buyerFeeTier, tier.body.tier);
    assert.ok(sameRate(firstSettlement.buyerFeeRate, ownRate), `buyer charged ${ownRate}`);
    const trades = items((await gateway(`/trades?orderId=${first.body.orderId}`, { token: ctx.token })).body);
    assert.equal(trades[0]?.buyerFeeTier, tier.body.tier, "tier recorded on the trade");

    // 3. Ops override (audited) changes the rate of the next fill only.
    const override = await ops(ctx.opsToken, `/users/${userId}/fee-tier/override`, { tier: "VIP2", note: "e2e 做市商计划" });
    assert.equal(override.status, 201, JSON.stringify(override.body));
    let vip2Rate;
    try {
      assert.equal(override.body.tier, "VIP2");
      assert.equal(override.body.source, "override");
      vip2Rate = override.body.markets.find((item) => item.market === market).takerFeeRate;
      const second = await placeFilledOrder(ctx.token, ctx.accountId, { market });
      assert.equal(second.body.status, "filled", JSON.stringify(second.body));
      const [secondSettlement] = await waitSettled(second.body.orderId);
      assert.equal(secondSettlement.buyerFeeTier, "VIP2");
      assert.ok(sameRate(secondSettlement.buyerFeeRate, vip2Rate), `VIP2 rate ${vip2Rate}`);
      assert.ok(
        Math.abs(Number(secondSettlement.buyerFeeAmount) - Number(secondSettlement.quantity) * Number(vip2Rate)) < 1e-12,
        "buyer fee = quantity x VIP2 rate"
      );
      const journals = await gateway(`/trades/${secondSettlement.tradeId}/journals`, { token: ctx.token });
      for (const journal of journals.body.journals) {
        assert.equal(journal.balanced, true, `journal ${journal.stage} balances`);
      }
      const unchanged = items(await fetchJson(`${SETTLEMENT}/api/v1/settlement/trades?orderId=${first.body.orderId}`))[0];
      assert.ok(sameRate(unchanged.buyerFeeRate, ownRate), "earlier trade keeps its recorded rate");
    } finally {
      const cleared = await ops(ctx.opsToken, `/users/${userId}/fee-tier/override/clear`, { note: "e2e 结束" });
      assert.equal(cleared.status, 201, JSON.stringify(cleared.body));
    }
    const detail = (await http(`${OPS}/users/${userId}/fee-tier`, { token: ctx.opsToken })).body;
    assert.equal(detail.source, "volume", "override cleared");
    assert.deepEqual(detail.audit.slice(0, 2).map((entry) => entry.action), ["clear", "set"]);
    const opsAudit = items((await http(`${OPS}/audit-logs/actions?action=fee_tier.override.set&targetId=${userId}&limit=1`, { token: ctx.opsToken })).body);
    assert.equal(opsAudit[0]?.action, "fee_tier.override.set", "override is in the ops action audit");

    // 4. Self-trade attempt: STP (matching engine, per account) expires the taker,
    //    so no trade, no fee and no wash-trade evidence. The wash detector stays as
    //    defence in depth for same-user trades STP cannot see (e.g. across accounts).
    const step = Number(definition.priceStep);
    const decimals = (definition.priceStep.split(".")[1] ?? "").length;
    let stpOrderId;
    for (let attempt = 0; attempt < 4 && !stpOrderId; attempt += 1) {
      const book = await fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${market}`);
      const bid = Number(book.bids[0]?.price ?? 0);
      const ask = Number(book.asks[0]?.price ?? 0);
      if (!(ask - bid > step * 2)) {
        await sleep(1_500);
        continue;
      }
      const price = (Math.round((bid + ask) / 2 / step) * step).toFixed(decimals);
      const resting = await placeOrder(ctx.token, ctx.accountId, { market, side: "sell", price, timeInForce: "gtc" });
      assert.equal(resting.status, 201, JSON.stringify(resting.body));
      const taker = await placeOrder(ctx.token, ctx.accountId, { market, side: "buy", price });
      if (taker.body.rejectedReason === "stp_expired_taker") {
        stpOrderId = taker.body.orderId;
        assert.equal(taker.body.filledQuantity, "0");
      }
      await gateway(`/orders/${resting.body.orderId}/cancel`, { token: ctx.token, body: {} });
    }
    assert.ok(stpOrderId, "STP expired the self-crossing taker");
    assert.equal(items((await gateway(`/trades?orderId=${stpOrderId}`, { token: ctx.token })).body).length, 0, "no self-trade");
    assert.equal(items(await fetchJson(`${SETTLEMENT}/api/v1/settlement/trades?orderId=${stpOrderId}`)).length, 0, "no fee without a fill");

    // 5. Spoofing: three large bids far below the market, each cancelled within seconds.
    const quantityStep = Number(definition.quantityStep);
    const qDecimals = (definition.quantityStep.split(".")[1] ?? "").length;
    const spoofIds = [];
    for (let index = 0; index < 3; index += 1) {
      const book = await fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${market}`);
      const price = (Math.floor((Number(book.bids[0].price) * 0.9) / step) * step).toFixed(decimals);
      const quantity = (Math.ceil(2_500 / Number(price) / quantityStep) * quantityStep).toFixed(qDecimals);
      const order = await placeOrder(ctx.token, ctx.accountId, { market, price, quantity, timeInForce: "gtc" });
      assert.equal(order.body.status, "accepted", JSON.stringify(order.body));
      await sleep(800);
      const cancel = await gateway(`/orders/${order.body.orderId}/cancel`, { token: ctx.token, body: {} });
      assert.equal(cancel.body.status, "cancelled");
      spoofIds.push(order.body.orderId);
    }

    // 6. Scan now (audited) and review the alerts with evidence.
    const scan = await ops(ctx.opsToken, "/surveillance/scan", {});
    assert.equal(scan.status, 201, JSON.stringify(scan.body));
    assert.equal(scan.body.error, undefined, `scan error: ${scan.body.error}`);
    const findAlert = async (type, predicate) =>
      items((await http(`${OPS}/surveillance/alerts?type=${type}&userId=${userId}&status=open&limit=50`, { token: ctx.opsToken })).body).find(predicate);
    const washAlerts = items((await http(`${OPS}/surveillance/alerts?type=wash_trade&userId=${userId}&limit=50`, { token: ctx.opsToken })).body);
    assert.ok(washAlerts.every((alert) => !alert.evidence.orderIds.includes(stpOrderId)), "STP-expired order is not wash evidence");
    const spoof = await findAlert("spoofing", (alert) => spoofIds.every((id) => alert.evidence.orderIds.includes(id)));
    assert.ok(spoof, "spoofing alert lists the cancelled orders as evidence");
    const overview = (await http(`${OPS}/surveillance/overview`, { token: ctx.opsToken })).body;
    assert.ok(overview.marketMakers.length > 0, "market makers are labelled");
    const makerAlerts = items((await http(`${OPS}/surveillance/alerts?userId=${overview.marketMakers[0].userId}&status=open&includeMarketMakers=true`, { token: ctx.opsToken })).body);
    assert.equal(makerAlerts.length, 0, "routine market-maker activity raises no alerts by default");

    const acknowledged = await ops(ctx.opsToken, `/surveillance/alerts/${spoof.alertId}/status`, { status: "acknowledged", note: "e2e 跟进" });
    assert.equal(acknowledged.body.status, "acknowledged", JSON.stringify(acknowledged.body));
    const noNote = await ops(ctx.opsToken, `/surveillance/alerts/${spoof.alertId}/status`, { status: "dismissed" });
    assert.equal(noNote.status, 400, "a note is required");
    const dismissed = await ops(ctx.opsToken, `/surveillance/alerts/${spoof.alertId}/status`, { status: "dismissed", note: "e2e 演示数据" });
    assert.equal(dismissed.body.status, "dismissed");
    assert.deepEqual(dismissed.body.events.map((event) => event.action), ["detected", "acknowledged", "dismissed"]);
    return `tier ${tier.body.tier}→VIP2 (${ownRate}→${vip2Rate}) · STP self-cross: no trade / no fee · spoof ${spoof.alertId.slice(0, 8)} reviewed`;
  },

  /**
   * Emergency switches (asset / global withdrawal pause, API write
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

      // a switch that is on shows up as a P2 alert
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

      // scheduled reconciliation (balance + order-vs-lock) is healthy
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
      const final = (await ops(t, "/controls")).body.state;
      assert.equal(final.withdrawalsPaused, null, "global pause is off at the end");
      assert.equal(final.apiWriteFrozen, null, "API write freeze is off at the end");
      assert.deepEqual(final.assetWithdrawalPauses, [], "no asset is paused at the end (breaker clear)");
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
