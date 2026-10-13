// Captures the screenshots used by docs/manual/ from a running, seeded stack
// (`pnpm demo:up`). Usage: `pnpm docs:screenshots [name-filter]`.

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_OPS, DEMO_TRADER, DEMO_WITHDRAWAL_ADDRESS, generateTotpCode } from "./mvp-demo-lib.mjs";

const require = createRequire(new URL("../apps/trader-web/package.json", import.meta.url));
const playwrightModule = await import(require.resolve("playwright-core"));
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "docs", "manual", "images");
const traderUrl = process.env.TRADER_WEB_URL ?? "http://127.0.0.1:3013";
const opsUrl = process.env.OPS_CONSOLE_URL ?? "http://127.0.0.1:3006";
const chromePath =
  process.env.MANUAL_SCREENSHOT_CHROME_PATH ??
  process.env.TRADER_WEB_SMOKE_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const filter = process.argv[2];

if (!existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}; set MANUAL_SCREENSHOT_CHROME_PATH`);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const viewport = { width: 1440, height: 900 };

async function shot(page, name, options = {}) {
  if (filter && !name.includes(filter)) {
    return;
  }
  if (options.fullPage) {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(options.settle ?? 1200);
  const target = options.selector ? page.locator(options.selector).first() : page;
  await target.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: options.fullPage ?? false });
  console.log(`saved ${name}.png`);
}

async function traderPage({ loggedIn }) {
  const context = await browser.newContext({ viewport, colorScheme: "light" });
  const page = await context.newPage();
  if (loggedIn) {
    await page.goto(`${traderUrl}/#/login`, { waitUntil: "domcontentloaded" });
    await page.click("#demo-login");
    await page.waitForSelector("#notification-bell", { timeout: 15_000 });
  }
  return page;
}

async function opsPage() {
  const context = await browser.newContext({ viewport, colorScheme: "light" });
  const page = await context.newPage();
  await page.goto(opsUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ops-login-form");
  return { context, page };
}

async function opsLogin(page) {
  await page.fill("#ops-login-form input[name=email]", DEMO_OPS.email);
  await page.fill("#ops-login-form input[name=password]", DEMO_OPS.password);
  await page.fill(
    "#ops-login-form input[name=twoFactorCode]",
    generateTotpCode(DEMO_OPS.twoFactorSecret, new Date()).code
  );
  await page.click("#ops-login-form button[type=submit]");
  await page.waitForSelector("#operator-chip", { timeout: 15_000 });
}

async function go(page, base, hash) {
  await page.goto(`${base}/#${hash}`, { waitUntil: "domcontentloaded" });
}

try {
  // ---- trader-web, public pages ----
  {
    const page = await traderPage({ loggedIn: false });
    await go(page, traderUrl, "/");
    await shot(page, "trader-home", { settle: 2500 });
    await shot(page, "trader-home-full", { fullPage: true, settle: 500 });
    await go(page, traderUrl, "/login");
    await shot(page, "trader-login");
    await page.context().close();
  }

  // ---- ops-console: make sure a proof-of-reserves snapshot exists for the trader page ----
  {
    const { context, page } = await opsPage();
    await opsLogin(page);
    await go(page, opsUrl, "/treasury");
    const generate = page.locator("#treasury-por-generate");
    await generate.waitFor({ timeout: 15_000 });
    await generate.click();
    const confirm = page.locator("#confirm-submit");
    if (await confirm.count()) {
      await page.fill("#confirm-note", "manual screenshot run").catch(() => {});
      await confirm.click();
    }
    await page.waitForTimeout(3000);
    await context.close();
  }

  // ---- trader-web, signed in ----
  {
    const page = await traderPage({ loggedIn: true });

    await go(page, traderUrl, "/trade/ETH-USDT");
    await page.waitForSelector("#order-book");
    await shot(page, "trader-trade", { settle: 3000 });
    await shot(page, "trader-order-book", { selector: "#order-book" });
    await shot(page, "trader-order-form", { selector: "#order-form" });

    // learning mode drawer
    await page.click("#learn-toggle");
    await shot(page, "trader-learn-drawer", { settle: 1500 });

    // place a small market buy so learning mode and replay have something to show
    await page.click("#order-side-buy");
    await page.click("#order-type-market");
    await page.fill("#order-quantity-input", "0.01");
    await page.click("#order-submit");
    await page.waitForTimeout(3000);
    await shot(page, "trader-learn-after-order", { settle: 500 });
    if (await page.locator("#match-replay").count()) {
      await shot(page, "trader-match-replay", { selector: "#match-replay" });
    }
    await page.click("#learn-toggle");

    // a resting limit order far below the market so it stays open
    await page.locator("#order-form").getByText("限价", { exact: true }).click();
    const last = Number((await page.locator("#market-last-price").innerText()).replace(/[^0-9.]/g, ""));
    await page.fill("#order-price-input", (Math.floor(last * 0.92 * 100) / 100).toFixed(2));
    await page.fill("#order-quantity-input", "0.02");
    await page.click("#order-submit");
    await page.waitForTimeout(2500);
    await shot(page, "trader-trade-open-orders", { settle: 500, fullPage: true });

    // post-only + STP options on a limit order, then the stop-order tab
    await page.check("#order-post-only");
    await shot(page, "trader-order-form-postonly", { selector: "#order-form", settle: 600 });
    await page.uncheck("#order-post-only");
    await page.click("#order-type-stop");
    await page.fill("#order-trigger-price-input", (Math.floor(last * 1.03 * 100) / 100).toFixed(2));
    await shot(page, "trader-order-form-stop", { selector: "#order-form", settle: 600 });
    await page.locator("#order-form").getByText("限价", { exact: true }).first().click();

    // guided tours
    await page.click("#tour-launcher");
    await shot(page, "trader-tour", { settle: 800 });
    await page.locator("#tour-picker .tour-list li").first().locator("button, a").first().click();
    await page.waitForSelector("#tour-panel");
    await shot(page, "trader-tour-active", { settle: 800 });
    await page.locator('#tour-panel [aria-label="退出导览"]').click();

    // notifications
    await page.click("#notification-bell");
    await shot(page, "trader-notifications", { settle: 800 });
    await page.keyboard.press("Escape");
    await page.mouse.click(10, 500);

    // orders & T-account journal
    await go(page, traderUrl, "/orders");
    await shot(page, "trader-orders", { settle: 2000 });
    await page.getByRole("tab", { name: "成交明细" }).click();
    await shot(page, "trader-orders-trades", { settle: 1500 });
    const journal = page.locator("[data-trade-journal]").first();
    if (await journal.count()) {
      await journal.click();
      await page.waitForSelector("#trade-journal-modal");
      await shot(page, "trader-trade-journal", { settle: 1000 });
      await page.keyboard.press("Escape");
    }

    // assets
    await go(page, traderUrl, "/assets");
    await page.waitForSelector("#balances-table");
    await shot(page, "trader-assets", { settle: 2000 });
    await shot(page, "trader-assets-full", { fullPage: true, settle: 300 });
    await shot(page, "trader-deposit", { selector: "#deposit-panel" });
    // faucet: simulate an on-chain transfer to the deposit address
    await page.locator("#deposit-panel").getByRole("button", { name: "模拟转入" }).click();
    await page.waitForTimeout(6000);
    await shot(page, "trader-deposit-records", { settle: 500, fullPage: true });
    // withdrawal request (goes to ops review)
    await page.getByRole("tab", { name: "提现", exact: true }).click();
    await page.waitForSelector("#withdraw-panel");
    await page.fill("#withdraw-panel input[name=toAddress]", DEMO_WITHDRAWAL_ADDRESS);
    await page.fill("#withdraw-panel input[name=amount]", "20");
    await page.locator("#withdraw-panel").getByRole("button", { name: "预校验" }).click();
    await page.waitForTimeout(1500);
    await shot(page, "trader-withdraw", { selector: "#withdraw-panel" });
    await page.click("#withdraw-submit");
    await page.waitForTimeout(2500);
    await page.getByRole("tab", { name: "提现记录" }).click();
    await shot(page, "trader-withdraw-records", { settle: 1500, fullPage: true });
    await go(page, traderUrl, "/assets/ledger");
    await page.waitForSelector("#statement-table");
    await shot(page, "trader-statement", { settle: 1500 });

    // proof of reserves: verify the user's own Merkle leaf in the browser
    await go(page, traderUrl, "/assets/reserves");
    await page.waitForSelector("#reserves-page");
    await page.locator("#reserves-verify").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.click("#reserves-verify");
    await page.locator("#reserves-verdict").waitFor({ timeout: 15_000 }).catch(() => {});
    await shot(page, "trader-reserves", { settle: 2500 });
    await shot(page, "trader-reserves-full", { settle: 300, fullPage: true });

    // account
    await go(page, traderUrl, "/account");
    await shot(page, "trader-account", { settle: 1500 });
    await shot(page, "trader-account-full", { fullPage: true, settle: 300 });
    await shot(page, "trader-2fa", { selector: "#two-factor-panel" });
    await shot(page, "trader-kyc", { selector: "#kyc-panel" });
    // submit a demo KYC application so the ops review queue has an entry
    if (await page.locator("#kyc-form").count()) {
      await page.fill("#kyc-form input[name=fullName]", "Demo Trader");
      await page.fill("#kyc-form input[name=idNumber]", "DEMO123456");
      await page.locator("#kyc-form button[type=submit]").click();
      await page.waitForTimeout(2000);
    }
    await shot(page, "trader-kyc-pending", { selector: "#kyc-panel" });
    await shot(page, "trader-api-key", { selector: "#api-key-form" });
    await shot(page, "trader-fee-tier", { selector: "#fee-tier-panel" });
    await page.locator("#device-table").scrollIntoViewIfNeeded();
    await shot(page, "trader-devices", { settle: 600 });

    await page.context().close();
  }

  // ---- ops-console ----
  {
    const { context, page } = await opsPage();
    await shot(page, "ops-login");
    await opsLogin(page);
    const pages = [
      ["dashboard", "/dashboard"],
      ["withdrawals", "/withdrawals"],
      ["deposits", "/deposits"],
      ["users", "/users"],
      ["trading", "/trading"],
      ["markets", "/markets"],
      ["trace", "/trace"],
      ["ledger", "/ledger"],
      ["system", "/system"],
      ["audit", "/audit"],
      ["treasury", "/treasury"],
      ["surveillance", "/surveillance"]
    ];
    for (const [name, hash] of pages) {
      await go(page, opsUrl, hash);
      await shot(page, `ops-${name}`, { settle: 2500 });
    }

    const tabs = [
      ["/system", "托管通道", "system-custody"],
      ["/system", "恢复队列", "system-recovery"],
      ["/system", "事件总线", "system-eventbus"],
      ["/system", "自动化作业", "system-automation"],
      ["/system", "实验室", "system-lab"],
      ["/system", "紧急开关", "system-controls"],
      ["/trading", "成交", "trading-trades"],
      ["/trading", "结算", "trading-settlements"],
      ["/trading", "订单簿健康", "trading-book"],
      ["/deposits", "待确认观察", "deposits-pending"],
      ["/users", "KYC 审核", "users-kyc"],
      ["/users", "余额", "users-balances"],
      ["/users", "提现地址簿", "users-addresses"],
      ["/users", "地址黑名单", "users-blacklist"]
    ];
    for (const [hash, label, name] of tabs) {
      if (filter && !`ops-${name}`.includes(filter)) {
        continue;
      }
      await go(page, opsUrl, hash);
      await page.getByRole("tab", { name: label }).first().click();
      await shot(page, `ops-${name}`, { settle: 2000 });
    }

    // detail views
    await go(page, opsUrl, "/withdrawals");
    await page.waitForSelector("#withdrawals-table");
    await page.locator("#withdrawals-table tbody tr").first().click();
    await shot(page, "ops-withdrawal-detail", { settle: 1500 });
    await go(page, opsUrl, `/users/${DEMO_TRADER.userId}`);
    await shot(page, "ops-user-detail", { settle: 2500 });
    await go(page, opsUrl, "/treasury");
    await shot(page, "ops-treasury-full", { settle: 2500, fullPage: true });
    await go(page, opsUrl, "/surveillance");
    if (await page.locator("#surveillance-scan").count()) {
      await page.click("#surveillance-scan");
      await page.waitForTimeout(2500);
    }
    await shot(page, "ops-surveillance-scanned", { settle: 1000 });
    await go(page, opsUrl, "/ledger");
    await shot(page, "ops-ledger-full", { settle: 2500, fullPage: true });
    await go(page, opsUrl, `/trace?userId=${DEMO_TRADER.userId}`);
    await shot(page, "ops-trace-user", { settle: 3000 });

    // approve the pending withdrawal, wait for on-chain confirmation, then trace it
    await go(page, opsUrl, "/withdrawals");
    const approve = page.locator("[data-approve]").first();
    await approve.waitFor({ timeout: 15_000 });
    const withdrawalId = await approve.getAttribute("data-approve");
    await approve.click();
    await page.fill("#confirm-note", "manual screenshot run");
    await shot(page, "ops-withdrawal-approve", { settle: 600 });
    await page.click("#confirm-submit");
    await page.waitForTimeout(30_000);
    await go(page, opsUrl, `/trace?withdrawalId=${withdrawalId}`);
    await shot(page, "ops-trace-withdrawal", { settle: 3000 });
    await shot(page, "ops-trace-withdrawal-full", { settle: 500, fullPage: true });
    await go(page, opsUrl, "/withdrawals");
    await page.getByRole("tab", { name: "全部提现" }).click();
    await shot(page, "ops-withdrawals-all", { settle: 2000 });
    await context.close();
  }
} finally {
  await browser.close();
}
