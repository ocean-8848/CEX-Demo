import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  bootstrapStandardDemo,
  DEMO_OPENING_BALANCE_ACCOUNT_ID,
  DEMO_MARKET,
  DEMO_WITHDRAWAL_ADDRESS,
  loadDemoConfig,
  setDemoMakersPaused
} from "./mvp-demo-lib.mjs";
import { maybeBuildInternalServiceHeaders } from "./internal-service-auth.mjs";

const require = createRequire(new URL("../apps/trader-web/package.json", import.meta.url));
const playwrightModule = await import(require.resolve("playwright-core"));
const chromium =
  playwrightModule.chromium ??
  playwrightModule.default?.chromium ??
  playwrightModule["module.exports"]?.chromium;

const DEFAULT_CHROME_PATHS = [
  process.env.TRADER_WEB_SMOKE_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter((value) => typeof value === "string" && value.length > 0);

const chromeExecutablePath = DEFAULT_CHROME_PATHS.find((candidate) => existsSync(candidate));
if (!chromeExecutablePath) {
  throw new Error("No Chrome executable found for trader-web local E2E");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.TRADER_WEB_LOCAL_E2E_BASE_URL ?? "http://127.0.0.1:3013";
const ledgerBaseUrl = process.env.TRADER_WEB_LOCAL_E2E_LEDGER_URL ?? "http://127.0.0.1:3001";
const market = process.env.TRADER_WEB_LOCAL_E2E_MARKET ?? DEMO_MARKET;
const email =
  process.env.TRADER_WEB_LOCAL_E2E_EMAIL ??
  `trader-web-local-${Date.now().toString()}@example.com`;
const password = process.env.TRADER_WEB_LOCAL_E2E_PASSWORD ?? "LocalSmokePass123!";
const withdrawAddress =
  process.env.TRADER_WEB_LOCAL_E2E_WITHDRAW_TO_ADDRESS ??
  DEMO_WITHDRAWAL_ADDRESS;
const withdrawalAmount = process.env.TRADER_WEB_LOCAL_E2E_WITHDRAW_AMOUNT ?? "12.5";
// The trader-web withdrawal form uses a fixed 1 USDT network fee.
const withdrawalFee = "1";
// Far below the market so it rests in the book instead of filling.
const orderPrice = process.env.TRADER_WEB_LOCAL_E2E_ORDER_PRICE ?? "2900";
const orderQuantity = process.env.TRADER_WEB_LOCAL_E2E_ORDER_QUANTITY ?? "0.05";
const fillOrderQuantity = process.env.TRADER_WEB_LOCAL_E2E_FILL_ORDER_QUANTITY ?? "0.05";
const fillOrderPrice = process.env.TRADER_WEB_LOCAL_E2E_FILL_ORDER_PRICE ?? "3300";
const autoSeed = readBooleanEnv("TRADER_WEB_LOCAL_E2E_AUTO_SEED", true);
const autoStartFrontend = readBooleanEnv("TRADER_WEB_LOCAL_E2E_START_FRONTEND", true);
const minimumUsdtBalance = Number(
  process.env.TRADER_WEB_LOCAL_E2E_MIN_USDT_BALANCE ??
    Math.max(Number(orderPrice) * Number(orderQuantity) + Number(withdrawalAmount) + Number(withdrawalFee) + 250, 1_500)
);

let frontendProcess;

const browser = await chromium.launch({
  executablePath: chromeExecutablePath,
  headless: true
});
const context = await browser.newContext();
const page = await context.newPage();

// The flow trades against the seeded book, so the simulator makers pause while it runs.
const demoConfig = loadDemoConfig(process.env);
await setDemoMakersPaused(demoConfig, true);

try {
  await ensureTraderWebAvailable();
  if (autoSeed) {
    await bootstrapStandardDemo(demoConfig);
  }

  await page.goto(`${baseUrl}/#/trade/${market}`, {
    waitUntil: "domcontentloaded"
  });
  await waitForAttribute(page, "#public-feed-status", "data-status", "live", 30_000);

  // Register a brand-new user; the gateway provisions their spot account.
  await page.goto(`${baseUrl}/#/login?mode=register`);
  await page.waitForSelector("#register-form", { timeout: 15_000 });
  await page.locator("#register-form input[name='displayName']").fill("Local Trader");
  await page.locator("#register-form input[name='email']").fill(email);
  await page.locator("#register-form input[name='password']").fill(password);
  await page.locator("#register-form button[type='submit']").click();

  await page.waitForSelector("#login-form", { timeout: 15_000 });
  await page.locator("#login-form input[name='email']").fill(email);
  await page.locator("#login-form input[name='password']").fill(password);
  await page.locator("#login-form button[type='submit']").click();
  await waitForAttribute(page, "#private-feed-status", "data-status", "live", 30_000);

  if (autoSeed) {
    await prepareLocalTradingState({
      page,
      ledgerBaseUrl,
      market,
      minimumUsdtBalance,
      withdrawAddress
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAttribute(page, "#private-feed-status", "data-status", "live", 30_000);
  }

  await page.goto(`${baseUrl}/#/trade/${market}`);
  await page.waitForSelector("#order-form", { timeout: 30_000 });
  await waitForNonEmptyText(page, "#order-available", 30_000);

  // 1. A resting limit order far from the market, then cancel it.
  await page.locator("#order-side-buy").click();
  await page.locator("#order-price-input").fill(orderPrice);
  await page.locator("#order-quantity-input").fill(orderQuantity);
  await page.locator("#order-submit").click();
  await waitForText(page, "#open-orders-table", "挂单中", 30_000);
  await page.locator("[data-cancel-order]").first().click();
  await page.waitForSelector("#open-orders-table", { state: "detached", timeout: 30_000 });

  // 2. A marketable IOC order that fills against the seeded asks.
  await page.locator("#order-form select[name='timeInForce']").selectOption("ioc");
  await page.locator("#order-price-input").fill(fillOrderPrice);
  await page.locator("#order-quantity-input").fill(fillOrderQuantity);
  await page.locator("#order-submit").click();
  await page.getByRole("tab", { name: /成交记录/ }).click();
  await page.waitForSelector("#trade-history-table", { timeout: 30_000 });

  // 3. Deposit address + simulated on-chain deposit (when demo-simulator runs).
  await page.goto(`${baseUrl}/#/assets?action=deposit&asset=USDT`);
  await page.waitForSelector("#deposit-panel", { timeout: 30_000 });
  if (await page.locator("#create-deposit-address").count()) {
    await page.locator("#create-deposit-address").click();
  }
  await waitForText(page, "#deposit-address", "0x", 30_000);
  const simulatorUp = await isHealthy(`${baseUrl}/api/demo/status`);
  if (simulatorUp) {
    await page.locator("#faucet-submit").click();
    await waitForText(page, "#deposits-table", "已入账", 60_000);
  }

  // 4. Withdrawal request (stays in manual review).
  await page.getByRole("tab", { name: "提现", exact: true }).click();
  await page.locator("#withdraw-panel input[name='toAddress']").fill(withdrawAddress);
  await page.locator("#withdraw-panel input[name='amount']").fill(withdrawalAmount);
  await page.locator("#withdraw-submit").click();
  await page.getByRole("tab", { name: /提现记录/ }).click();
  await waitForNonEmptyText(page, "#withdrawals-table tbody", 30_000);

  // 5. Network blip: the private socket reconnects and resumes.
  await context.setOffline(true);
  await context.setOffline(false);
  await waitForAttribute(page, "#private-feed-status", "data-status", "live", 30_000);

  // Same-origin call with no Authorization header: the Web Host attaches the cookie session.
  const accountId = await page.evaluate(async () => {
    const response = await fetch("/api/gateway/accounts/spot");
    return (await response.json()).accountId;
  });
  assert.ok(accountId, "cookie session did not authorize a same-origin gateway call");

  console.log(
    JSON.stringify(
      {
        baseUrl,
        email,
        market,
        accountId,
        filledOrderPrice: fillOrderPrice,
        filledOrderQuantity: fillOrderQuantity,
        autoSeed,
        simulatorDeposit: simulatorUp,
        status: "ok"
      },
      null,
      2
    )
  );
} finally {
  await setDemoMakersPaused(demoConfig, false);
  await page.close();
  await context.close();
  await browser.close();
  if (frontendProcess) {
    terminateProcessGroup(frontendProcess.pid, "SIGTERM");
    await waitForExit(frontendProcess, 5_000).catch(() => {
      terminateProcessGroup(frontendProcess.pid, "SIGKILL");
    });
  }
}

async function ensureTraderWebAvailable() {
  if (await isHealthy(`${baseUrl}/healthz`)) {
    return;
  }

  if (!autoStartFrontend) {
    throw new Error(`trader-web is not healthy at ${baseUrl}`);
  }

  frontendProcess = spawn(
    "pnpm",
    ["--filter", "@web3-cex/trader-web", "start"],
    {
      cwd: repoRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const logBuffer = [];
  frontendProcess.stdout?.on("data", (chunk) => {
    logBuffer.push(String(chunk));
    while (logBuffer.length > 20) {
      logBuffer.shift();
    }
  });
  frontendProcess.stderr?.on("data", (chunk) => {
    logBuffer.push(String(chunk));
    while (logBuffer.length > 20) {
      logBuffer.shift();
    }
  });

  try {
    await waitForHealth(`${baseUrl}/healthz`, 60_000);
  } catch (error) {
    throw new Error(
      `Failed to start trader-web locally: ${
        error instanceof Error ? error.message : "unknown startup error"
      }\n${logBuffer.join("")}`.trim()
    );
  }
}

async function prepareLocalTradingState(params) {
  const { page, ledgerBaseUrl: currentLedgerBaseUrl, market: currentMarket, minimumUsdtBalance: minimumBalance, withdrawAddress: currentWithdrawAddress } = params;
  const config = await fetchJson(`${baseUrl}/api/config`);
  // the session token is an HttpOnly cookie. Page scripts must not see it;
  // the test harness reads it from the browser context to drive API setup.
  const exposed = await page.evaluate(() => ({
    cookie: document.cookie,
    stored: Object.keys(localStorage).filter((key) => /token/i.test(key))
  }));
  assert.ok(!/tw_session=/.test(exposed.cookie), "tw_session cookie is readable by page scripts");
  assert.deepEqual(exposed.stored, [], "session token found in localStorage");
  const sessionCookie = (await page.context().cookies(baseUrl)).find((cookie) => cookie.name === "tw_session");
  assert.ok(sessionCookie?.httpOnly, "Missing HttpOnly trader-web session cookie after login");
  const token = decodeURIComponent(sessionCookie.value);

  const session = await fetchJson(`${baseUrl}${config.gatewayHttpBasePath}/auth/me`, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  const accountId =
    process.env.TRADER_WEB_LOCAL_E2E_ACCOUNT_ID ??
    (
      await fetchJson(`${baseUrl}${config.gatewayHttpBasePath}/accounts/spot`, {
        headers: {
          authorization: `Bearer ${token}`
        }
      })
    ).accountId;
  const openingBalanceAccountId =
    process.env.TRADER_WEB_LOCAL_E2E_OPENING_BALANCE_ACCOUNT_ID ??
    DEMO_OPENING_BALANCE_ACCOUNT_ID;

  await ensureLedgerAccount(currentLedgerBaseUrl, {
    accountId: openingBalanceAccountId,
    accountType: "opening_balance"
  });
  await ensureLedgerAccount(currentLedgerBaseUrl, {
    accountId,
    userId: String(session.userId),
    accountType: "spot"
  });

  const currentUsdtBalance = await readAvailableBalance(currentLedgerBaseUrl, accountId, "USDT");
  if (currentUsdtBalance < minimumBalance) {
    const topUpAmount = formatAmount(minimumBalance - currentUsdtBalance);
    await postJournal(currentLedgerBaseUrl, {
      businessType: "local_e2e_seed",
      businessId: `local-e2e-${Date.now().toString()}`,
      idempotencyKey: `local-e2e-${Date.now().toString()}`,
      traceId: `local-e2e:${accountId}:seed`,
      description: `Seed trader-web local E2E balance for ${currentMarket}`,
      entries: [
        {
          accountId: openingBalanceAccountId,
          assetCode: "USDT",
          direction: "debit",
          amount: topUpAmount,
          referenceType: "local_e2e_seed",
          referenceId: `${accountId}:opening`
        },
        {
          accountId,
          assetCode: "USDT",
          direction: "credit",
          amount: topUpAmount,
          referenceType: "local_e2e_seed",
          referenceId: `${accountId}:spot`
        }
      ]
    });
  }

  await ensureWithdrawalWhitelistEntry(
    `${baseUrl}${config.gatewayHttpBasePath}`,
    token,
    currentWithdrawAddress
  );
}

async function ensureLedgerAccount(ledgerBaseUrl, payload) {
  const path = "/api/v1/ledger/accounts";
  const body = JSON.stringify(payload);
  const response = await fetch(`${ledgerBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...maybeBuildInternalServiceHeaders(`${ledgerBaseUrl}${path}`, {
        method: "POST",
        body
      })
    },
    body
  });

  if (response.ok) {
    return response.json();
  }

  if (response.status === 409 || response.status === 400) {
    const text = await response.text();
    if (/exist|duplicate|already/i.test(text)) {
      return null;
    }
    throw new Error(`Ledger account create failed: ${text}`);
  }

  throw new Error(`Ledger account create failed: ${await response.text()}`);
}

async function readAvailableBalance(ledgerBaseUrl, accountId, assetCode) {
  const payload = await fetchJson(
    `${ledgerBaseUrl}/api/v1/ledger/balances?${new URLSearchParams({
      accountId,
      assetCode,
      limit: "1",
      offset: "0"
    }).toString()}`
  );
  const item = Array.isArray(payload?.items) ? payload.items[0] : undefined;
  return Number(item?.available ?? "0");
}

async function postJournal(ledgerBaseUrl, payload) {
  return fetchJson(`${ledgerBaseUrl}/api/v1/ledger/journals`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function ensureWithdrawalWhitelistEntry(gatewayBasePath, token, address) {
  const existing = await fetchJson(
    `${gatewayBasePath}/withdrawal-address-book?${new URLSearchParams({
      address,
      network: "ethereum",
      limit: "10",
      offset: "0"
    }).toString()}`,
    {
      headers: {
        authorization: `Bearer ${token}`
      }
    }
  );
  const matched = Array.isArray(existing?.items)
    ? existing.items.find((item) => item.address === address && item.network === "ethereum")
    : undefined;
  if (matched?.isWhitelisted === true) {
    return matched;
  }

  const response = await fetch(`${gatewayBasePath}/withdrawal-address-book`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `local-e2e-withdrawal-address:${address}`
    },
    body: JSON.stringify({
      network: "ethereum",
      address,
      label: "Local E2E Withdrawal Address",
      isWhitelisted: true
    })
  });
  if (!response.ok) {
    throw new Error(`Failed to whitelist withdrawal address: ${await response.text()}`);
  }

  return response.json();
}

async function isHealthy(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    if (await isHealthy(url)) {
      return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${url}`);
    }
    await sleep(1_000);
  }
}

async function waitForExit(child, timeoutMs) {
  await Promise.race([
    new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    }),
    sleep(timeoutMs).then(() => {
      throw new Error("Timed out waiting for child process exit");
    })
  ]);
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...maybeBuildInternalServiceHeaders(url, init)
    }
  });
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function formatAmount(value) {
  return Number(value).toFixed(8).replace(/\.?0+$/, "");
}

function readBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value !== "false";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function terminateProcessGroup(pid, signal) {
  if (typeof pid !== "number" || pid <= 0) {
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall through when the process is not running in its own group.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Ignore cleanup failures if the process is already gone.
  }
}

async function waitForAttribute(page, selector, name, value, timeout = 15_000) {
  await page.waitForFunction(
    ({ currentSelector, attribute, expected }) =>
      document.querySelector(currentSelector)?.getAttribute(attribute) === expected,
    { currentSelector: selector, attribute: name, expected: value },
    { timeout }
  );
}

async function waitForText(page, selector, text, timeout = 15_000) {
  await page.waitForFunction(
    ({ selector: currentSelector, text: expectedText }) => {
      const element = document.querySelector(currentSelector);
      return element?.textContent?.includes(expectedText) ?? false;
    },
    { selector, text },
    { timeout }
  );
}

async function waitForNonEmptyText(page, selector, timeout = 15_000) {
  await page.waitForFunction(
    (currentSelector) => {
      const element = document.querySelector(currentSelector);
      const value = element?.textContent?.trim() ?? "";
      return value.length > 0 && value !== "{}";
    },
    selector,
    { timeout }
  );
}

