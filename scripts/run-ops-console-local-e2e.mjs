// End-to-end check of the ops-console UI against the running local stack:
// withdrawal review -> custody broadcast -> simulated chain confirmation,
// business trace, ledger reconciliation, user freeze / unfreeze and audit log.
//
// Prerequisites: `pnpm demo:up` (or stack:start + demo:prepare) and a local Chrome.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import {
  DEMO_OPS,
  DEMO_TRADER,
  DEMO_WITHDRAWAL_ADDRESS,
  fetchJson,
  generateTotpCode,
  loadDemoConfig,
  setDemoMakersPaused,
  waitForCondition
} from "./mvp-demo-lib.mjs";

const require = createRequire(new URL("../apps/trader-web/package.json", import.meta.url));
const playwrightModule = await import(require.resolve("playwright-core"));
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const chromePath = [
  process.env.OPS_CONSOLE_E2E_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].find((candidate) => candidate && existsSync(candidate));
if (!chromePath) {
  throw new Error("No Chrome executable found for ops-console local E2E");
}

const config = loadDemoConfig(process.env);
const opsUrl = process.env.OPS_CONSOLE_E2E_BASE_URL ?? config.opsConsoleBaseUrl;
const gateway = `${config.gatewayBaseUrl}/api/v1/gateway`;

// 1. A customer withdrawal that needs review.
const traderSession = await fetchJson(`${gateway}/auth/sessions`, {
  method: "POST",
  body: JSON.stringify({ email: DEMO_TRADER.email, password: DEMO_TRADER.password })
});
const traderAuth = { authorization: `Bearer ${traderSession.token}` };
const { accountId } = await fetchJson(`${gateway}/accounts/spot`, { headers: traderAuth });
const withdrawal = await fetchJson(`${gateway}/withdrawals/request`, {
  method: "POST",
  headers: { ...traderAuth, "idempotency-key": randomUUID() },
  body: JSON.stringify({
    ledgerAccountId: accountId,
    assetCode: "USDT",
    network: config.demoNetwork,
    toAddress: config.withdrawalAddress ?? DEMO_WITHDRAWAL_ADDRESS,
    amount: "15",
    fee: "1"
  })
});
const withdrawalId = withdrawal.withdrawalId;

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  // 2. Login with password + TOTP. Wait for a fresh time step so the code was not used yet.
  await page.goto(opsUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ops-login-form");
  const secondsIntoStep = Math.floor(Date.now() / 1000) % 30;
  if (secondsIntoStep > 25) {
    await page.waitForTimeout((31 - secondsIntoStep) * 1000);
  }
  await page.fill("#ops-login-form input[name=email]", DEMO_OPS.email);
  await page.fill("#ops-login-form input[name=password]", DEMO_OPS.password);
  await page.fill("#ops-login-form input[name=twoFactorCode]", generateTotpCode(DEMO_OPS.twoFactorSecret, new Date()).code);
  await page.click("#ops-login-form button[type=submit]");
  await page.waitForSelector("#nav-dashboard", { timeout: 15_000 });
  // the session token sits in an HttpOnly cookie that page scripts cannot read.
  const exposure = await page.evaluate(() => ({
    cookie: document.cookie,
    storage: Object.keys(localStorage).filter((key) => /token/i.test(key))
  }));
  if (/ops_session=/.test(exposure.cookie) || exposure.storage.length > 0) {
    throw new Error(`ops session token is visible to scripts: ${JSON.stringify(exposure)}`);
  }
  if (!/ops_csrf=/.test(exposure.cookie)) {
    throw new Error("ops CSRF cookie missing after login");
  }
  // A reload must keep the session via the cookie alone.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#nav-dashboard", { timeout: 15_000 });

  // 3. Approve the withdrawal from the review queue.
  await page.click("#nav-withdrawals");
  const approveButton = page.locator(`[data-approve="${withdrawalId}"]`);
  await approveButton.waitFor({ timeout: 15_000 });
  await approveButton.click();
  await page.fill("#confirm-note", "ops-console local e2e");
  await page.click("#confirm-submit");
  await page.locator(`[data-approve="${withdrawalId}"]`).waitFor({ state: "detached", timeout: 15_000 });

  // 4. Custody broadcasts, then the demo-simulator chain confirms it.
  const simulatorUp = await fetch(`${config.demoSimulatorBaseUrl}/api/demo/status`).then((response) => response.ok).catch(() => false);
  const finalStatus = await waitForCondition(
    "withdrawal broadcast / confirmation",
    async () => {
      const current = await fetchJson(`${gateway}/withdrawals/${withdrawalId}`, { headers: traderAuth });
      const done = simulatorUp ? current.status === "confirmed" : ["broadcasted", "confirmed"].includes(current.status);
      return done ? current.status : null;
    },
    { timeoutMs: 60_000, intervalMs: 1_500 }
  );

  // 5. Business trace for the same withdrawal.
  await page.goto(`${opsUrl}/#/trace?withdrawalId=${withdrawalId}`);
  await page.waitForSelector("#trace-result", { timeout: 15_000 });
  const traceText = await page.locator("#trace-result").innerText();
  assert.match(traceText, /withdrawal/i);

  // 6. Ledger reconciliation is clean (makers paused so balances are quiescent).
  await setDemoMakersPaused(config, true);
  try {
    await page.goto(`${opsUrl}/#/ledger`);
    await page.getByText("账本完全一致").waitFor({ timeout: 15_000 });
  } finally {
    await setDemoMakersPaused(config, false);
  }

  // 7. Freeze and unfreeze the demo trader.
  await page.goto(`${opsUrl}/#/users/${DEMO_TRADER.userId}`);
  await page.waitForSelector("#user-detail", { timeout: 15_000 });
  await page.click("#freeze-user");
  await page.fill("#confirm-note", "ops-console local e2e");
  await page.click("#confirm-submit");
  await page.getByRole("button", { name: "解冻用户" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "解冻用户" }).click();
  await page.click("#confirm-submit");
  await page.locator("#freeze-user").waitFor({ timeout: 15_000 });

  // 8. Every action above is in the audit log.
  await page.goto(`${opsUrl}/#/audit`);
  await page.waitForSelector("#action-audit-table", { timeout: 15_000 });
  const auditText = await page.locator("#action-audit-table").innerText();
  assert.match(auditText, /withdrawal\.approve/);
  assert.match(auditText, /user\.freeze|users?\.freeze/);

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: "ok", withdrawalId, finalStatus, simulatorUp }, null, 2));
} finally {
  await browser.close();
}
