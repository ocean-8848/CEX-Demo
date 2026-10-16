import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { existsSync } from "node:fs";
import test from "node:test";

import { chromium, type Page } from "playwright-core";
import { WebSocketServer, type WebSocket } from "ws";

import { DEFAULT_PUBLIC_DIR, buildRuntimeConfig, createTraderWebServer } from "../server.js";

const DEFAULT_CHROME_PATHS = [
  process.env.TRADER_WEB_SMOKE_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter((value): value is string => typeof value === "string" && value.length > 0);

const CHROME_EXECUTABLE_PATH = DEFAULT_CHROME_PATHS.find((candidate) => existsSync(candidate));

test(
  "trader-web smoke covers login, order, cancel, deposit, withdrawal, and reconnect",
  {
    skip: !CHROME_EXECUTABLE_PATH
  },
  async (t) => {
    const gatewayState = createGatewayState();
    const marketState = createMarketState();
    const gatewayHttpServer = createGatewayHttpServer(gatewayState);
    const marketHttpServer = createMarketHttpServer(marketState);
    const gatewayRealtimeServer = createServer();
    const marketRealtimeServer = createServer();
    const gatewayRealtime = createGatewayRealtimeHarness(gatewayState, gatewayRealtimeServer);
    const marketRealtime = createMarketRealtimeHarness(marketState, marketRealtimeServer);

    await Promise.all([
      listen(gatewayHttpServer),
      listen(marketHttpServer),
      listen(gatewayRealtimeServer),
      listen(marketRealtimeServer)
    ]);

    const gatewayHttpAddress = readAddress(gatewayHttpServer);
    const marketHttpAddress = readAddress(marketHttpServer);
    const gatewayRealtimeAddress = readAddress(gatewayRealtimeServer);
    const marketRealtimeAddress = readAddress(marketRealtimeServer);

    const traderServer = createTraderWebServer(
      {
        ...buildRuntimeConfig({ TRADER_WEB_DEMO_MODE: "false" }),
        appTitle: "Trader Web Smoke",
        gatewayBaseUrl: `http://127.0.0.1:${gatewayHttpAddress.port}`,
        marketDataBaseUrl: `http://127.0.0.1:${marketHttpAddress.port}`,
        gatewayWsUrl: `ws://127.0.0.1:${gatewayRealtimeAddress.port}/api/v1/gateway/realtime`,
        marketDataWsUrl: `ws://127.0.0.1:${marketRealtimeAddress.port}/api/v1/market-data/ws`,
        gatewayHttpBasePath: "/api/gateway",
        marketDataHttpBasePath: "/api/market"
      },
      DEFAULT_PUBLIC_DIR
    );
    await listen(traderServer);
    const traderAddress = readAddress(traderServer);
    const traderBaseUrl = `http://127.0.0.1:${traderAddress.port}`;

    const browser = await chromium.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    t.after(async () => {
      await browser.close();
      await Promise.all([gatewayRealtime.close(), marketRealtime.close()]);
      await Promise.all([
        close(traderServer),
        close(gatewayHttpServer),
        close(marketHttpServer),
        close(gatewayRealtimeServer),
        close(marketRealtimeServer)
      ]);
    });

    await page.goto(`${traderBaseUrl}/#/trade/ETH-USDT`, {
      waitUntil: "domcontentloaded"
    });

    // Public market data is live before login.
    await waitForAttribute(page, "#public-feed-status", "data-status", "live");
    await waitForText(page, "#order-book", "3,201.00");

    // Register, then log in with the same credentials.
    await page.goto(`${traderBaseUrl}/#/login?mode=register`);
    await page.waitForSelector("#register-form");
    await page.locator("#register-form input[name='displayName']").fill("Smoke Trader");
    await page.locator("#register-form input[name='email']").fill("smoke@example.com");
    await page.locator("#register-form input[name='password']").fill("test-pass-123");
    await page.locator("#register-form button[type='submit']").click();
    await waitForCondition(() => gatewayState.registerCount === 1);

    await page.waitForSelector("#login-form");
    await page.locator("#login-form input[name='email']").fill("smoke@example.com");
    await page.locator("#login-form input[name='password']").fill("test-pass-123");
    await page.locator("#login-form button[type='submit']").click();
    await waitForAttribute(page, "#private-feed-status", "data-status", "live");
    await waitForText(page, "#session-status", "Smoke Trader");

    // Learning mode explains what the order request goes through.
    await page.locator("#learn-toggle").click();
    await page.waitForSelector("#learn-drawer");

    // Place a resting limit order, then cancel it.
    await page.waitForSelector("#order-form");
    await waitForText(page, "#order-available", "1,000");
    await page.locator("#order-price-input").fill("3200");
    await page.locator("#order-quantity-input").fill("0.01");
    await page.locator("#order-submit").click();
    await waitForCondition(() => gatewayState.orderCounter >= 1);
    await waitForText(page, "#open-orders-table", "挂单中");
    await waitForText(page, "#learn-drawer", "POST /orders");
    // the order (buy 3200, best ask 3201) did not cross, so the replay
    // ends with the order resting in the book.
    await waitForText(page, "#match-replay", "撮合过程回放");
    await waitForText(page, "#match-replay", "未成交，整单挂入订单簿");

    await page.locator("[data-cancel-order]").first().click();
    await page.waitForSelector("#open-orders-table", { state: "detached" });
    await page.getByRole("tab", { name: /历史委托/ }).click();
    await waitForText(page, "#order-history-table", "已撤销");

    // a trade opens its masked ledger journals as T-accounts.
    await page.getByRole("tab", { name: /成交记录/ }).click();
    await page.locator("[data-trade-journal='trade-seed-1']").click();
    await waitForText(page, "#trade-journal-modal", "借贷平衡");
    await waitForText(page, "#trade-journal-modal", "对手方");
    await waitForText(page, "#journal-balance-check", "✓ 相等");
    await page.locator(".modal [aria-label='关闭']").click();
    await page.waitForSelector("#trade-journal-modal", { state: "detached" });

    // Funding: generate a deposit address and request a withdrawal.
    await page.goto(`${traderBaseUrl}/#/assets`);
    // Loaded by the REST account snapshot right after login (no page reload).
    await page.locator("#deposit-asset button", { hasText: "ETH" }).click();
    await waitForText(page, "#deposit-address", "0xethdeposit456");
    await page.locator("#deposit-asset button", { hasText: "USDT" }).click();
    await page.locator("#create-deposit-address").click();
    await waitForText(page, "#deposit-address", "0xdeposit123");

    await page.getByRole("tab", { name: "提现", exact: true }).click();
    await page.locator("#withdraw-panel input[name='toAddress']").fill(
      "0x1234567890abcdef1234567890abcdef12345678"
    );
    await page.locator("#withdraw-panel input[name='amount']").fill("12.5");
    await page.locator("#withdraw-submit").click();
    await page.getByRole("tab", { name: /提现记录/ }).click();
    await waitForText(page, "#withdrawals-table", "已申请");

    // The mock gateway drops the private socket after the withdrawal; the
    // client must reconnect and resume from its last sequence number.
    await waitForCondition(() => gatewayState.reconnectObserved, 15_000);
    await waitForAttribute(page, "#private-feed-status", "data-status", "live");

    // the bell shows the server unread count; "全部已读" persists it.
    await waitForText(page, "#notification-unread-count", "1");
    await page.locator("#notification-bell").click();
    await waitForText(page, "#notification-panel", "提现申请已提交");
    await page.locator("#notification-read-all").click();
    await waitForCondition(() => gatewayState.readAllCount === 1);
    await page.waitForSelector("#notification-unread-count", { state: "detached" });
    await page.keyboard.press("Escape");

    // the statement page lists ledger lines and filters server-side.
    await page.goto(`${traderBaseUrl}/#/assets/ledger`);
    await waitForText(page, "#statement-table", "充值入账");
    await waitForText(page, "#statement-table", "提现冻结");
    await waitForText(page, "#statement-total", "共 2 条");
    await page.locator("#statement-category").selectOption("withdrawal");
    await waitForCondition(() =>
      gatewayState.statementQueries.some((query) => query.includes("category=withdrawal"))
    );
    await waitForText(page, "#statement-total", "共 1 条");

    assert.equal(gatewayState.registerCount, 1);
    assert.equal(gatewayState.loginCount, 1);
    assert.equal(gatewayState.orderCounter >= 1, true);
    assert.equal(gatewayState.reconnectObserved, true);
    // the private socket was authenticated by the Web Host, and the page
    // never held the session token.
    assert.equal(gatewayState.wsBearerSeen, true);
    const exposure = await page.evaluate(() => ({
      cookie: document.cookie,
      storage: Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`)
    }));
    assert.doesNotMatch(exposure.cookie, /tw_session=/);
    assert.ok(!exposure.storage.some((entry) => entry.includes(gatewayState.token)), "token leaked to localStorage");
  }
);

interface MockGatewayState {
  token: string;
  session: Record<string, unknown>;
  accounts: Array<Record<string, unknown>>;
  balances: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  deposits: Array<Record<string, unknown>>;
  withdrawals: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  accountEvents: Array<Record<string, unknown>>;
  registerCount: number;
  loginCount: number;
  orderCounter: number;
  reconnectObserved: boolean;
  wsBearerSeen: boolean;
  readAllCount: number;
  statementQueries: string[];
  statementLines: Array<Record<string, unknown>>;
}

function createGatewayState(): MockGatewayState {
  return {
    token: "token-smoke-1",
    session: {
      userId: "user-smoke-1",
      email: "smoke@example.com",
      displayName: "Smoke Trader"
    },
    accounts: [
      {
        accountId: "acct-spot-1",
        accountType: "spot"
      }
    ],
    balances: [
      {
        accountId: "acct-spot-1",
        accountType: "spot",
        assetCode: "USDT",
        available: "1000",
        locked: "0",
        updatedAt: "2026-03-10T10:00:00.000Z"
      }
    ],
    orders: [],
    trades: [
      {
        tradeId: "trade-seed-1",
        market: "ETH-USDT",
        buyerUserId: "user-smoke-1",
        sellerUserId: "user-other",
        price: "3199",
        quantity: "0.01",
        executedAt: "2026-03-10T10:00:00.000Z"
      }
    ],
    deposits: [],
    withdrawals: [],
    notifications: [],
    accountEvents: [
      {
        entityType: "session",
        entityId: "auth-1",
        updatedAt: "2026-03-10T10:00:00.000Z"
      }
    ],
    registerCount: 0,
    loginCount: 0,
    orderCounter: 0,
    reconnectObserved: false,
    wsBearerSeen: false,
    readAllCount: 0,
    statementQueries: [],
    statementLines: [
      {
        lineId: "lock:ev-2",
        source: "lock_event",
        occurredAt: "2026-03-10T10:07:00.000Z",
        assetCode: "USDT",
        category: "withdrawal",
        action: "withdrawal_freeze",
        amount: "13.5",
        totalDelta: "0",
        availableDelta: "-13.5",
        lockedDelta: "13.5",
        balanceAfter: { total: "1000", available: "986.5", locked: "13.5" },
        referenceType: "withdrawal",
        referenceId: "withdrawal-1"
      },
      {
        lineId: "entry:e-1",
        source: "entry",
        occurredAt: "2026-03-10T09:00:00.000Z",
        assetCode: "USDT",
        category: "deposit",
        action: "deposit_credit",
        amount: "1000",
        totalDelta: "1000",
        availableDelta: "1000",
        lockedDelta: "0",
        balanceAfter: { total: "1000", available: "1000", locked: "0" },
        businessType: "deposit_confirmed",
        referenceType: "deposit",
        referenceId: "deposit-seed-1",
        journalId: "journal-1"
      }
    ]
  };
}

/** Shape of GET /gateway/trades/:id/journals (already masked by the gateway). */
function createTradeJournalView() {
  const entry = (
    accountRole: string,
    accountLabel: string,
    assetCode: string,
    direction: "debit" | "credit",
    amount: string,
    referenceType = "spot_trade"
  ) => ({ accountRole, accountLabel, assetCode, direction, amount, referenceType });
  const journal = (journalId: string, stage: string, stageLabel: string, entries: unknown[]) => ({
    journalId,
    businessType: stage,
    stage,
    stageLabel,
    createdAt: "2026-03-10T10:00:01.000Z",
    entries,
    totals: [],
    balanced: true
  });
  return {
    tradeId: "trade-seed-1",
    market: "ETH-USDT",
    price: "3199",
    quantity: "0.01",
    executedAt: "2026-03-10T10:00:00.000Z",
    viewerSide: "buy",
    viewerLiquidity: "taker",
    settled: true,
    balanced: true,
    totals: [],
    viewerChanges: [
      { assetCode: "ETH", netChange: "0.00999" },
      { assetCode: "USDT", netChange: "-31.99" }
    ],
    journals: [
      journal("j1", "lock_consume", "消耗对手方委托冻结的 ETH，划入结算中转账户", [
        entry("counterparty", "对手方", "ETH", "debit", "0.01", "spot_order"),
        entry("platform_settlement", "平台结算中转账户（ETH）", "ETH", "credit", "0.01", "spot_order")
      ]),
      journal("j2", "lock_consume", "消耗我的委托冻结的 USDT，划入结算中转账户", [
        entry("self", "我的现货账户", "USDT", "debit", "31.99", "spot_order"),
        entry("platform_settlement", "平台结算中转账户（USDT）", "USDT", "credit", "31.99", "spot_order")
      ]),
      journal("j3", "settle_base", "交割基础资产 ETH", [
        entry("platform_settlement", "平台结算中转账户（ETH）", "ETH", "debit", "0.01"),
        entry("self", "我的现货账户", "ETH", "credit", "0.00999"),
        entry("platform_fee", "平台手续费账户（ETH）", "ETH", "credit", "0.00001", "spot_trade_fee")
      ]),
      journal("j4", "settle_quote", "交割计价资产 USDT", [
        entry("platform_settlement", "平台结算中转账户（USDT）", "USDT", "debit", "31.99"),
        entry("counterparty", "对手方", "USDT", "credit", "31.974005"),
        entry("platform_fee", "平台手续费账户（USDT）", "USDT", "credit", "0.015995", "spot_trade_fee")
      ])
    ]
  };
}

function createMarketState() {
  return {
    tickers: [
      {
        market: "ETH-USDT",
        lastPrice: "3200",
        priceChange24h: "120",
        highPrice24h: "3250",
        lowPrice24h: "3150",
        volume24h: "123.45"
      }
    ],
    depth: {
      bids: [{ price: "3199", quantity: "1.2", orderCount: 2 }],
      asks: [{ price: "3201", quantity: "0.8", orderCount: 1 }]
    },
    trades: [
      {
        tradeId: "public-trade-1",
        price: "3200",
        quantity: "0.01",
        executedAt: "2026-03-10T10:00:00.000Z"
      }
    ],
    analytics: {
      periods: [
        {
          interval: "1h",
          closePrice: "3200",
          priceChange: "120"
        },
        {
          interval: "4h",
          closePrice: "3180",
          priceChange: "240"
        }
      ]
    }
  };
}

function createGatewayHttpServer(state: MockGatewayState): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = (request.method ?? "GET").toUpperCase();

    if (url.pathname === "/api/v1/gateway/auth/register" && method === "POST") {
      state.registerCount += 1;
      await readJson(request);
      return writeJson(response, 201, {
        userId: state.session.userId,
        email: state.session.email
      });
    }

    if (url.pathname === "/api/v1/gateway/auth/sessions" && method === "POST") {
      state.loginCount += 1;
      await readJson(request);
      return writeJson(response, 200, {
        token: state.token,
        ...state.session
      });
    }

    if (!isAuthorized(request, state.token)) {
      return writeJson(response, 401, {
        message: "unauthorized"
      });
    }

    if (url.pathname === "/api/v1/gateway/auth/me" && method === "GET") {
      return writeJson(response, 200, state.session);
    }
    if (url.pathname === "/api/v1/gateway/auth/logout" && method === "POST") {
      return writeJson(response, 200, {
        revoked: true
      });
    }
    if (url.pathname === "/api/v1/gateway/balances" && method === "GET") {
      return writeJson(response, 200, {
        items: state.balances,
        total: state.balances.length,
        limit: 20,
        offset: 0
      });
    }
    if (url.pathname === "/api/v1/gateway/orders" && method === "GET") {
      return writeJson(response, 200, state.orders);
    }
    if (url.pathname === "/api/v1/gateway/trades" && method === "GET") {
      return writeJson(response, 200, state.trades);
    }
    if (url.pathname === "/api/v1/gateway/trades/trade-seed-1/journals" && method === "GET") {
      return writeJson(response, 200, createTradeJournalView());
    }
    if (url.pathname === "/api/v1/gateway/deposits" && method === "GET") {
      return writeJson(response, 200, {
        items: state.deposits,
        total: state.deposits.length,
        limit: 10,
        offset: 0
      });
    }
    if (url.pathname === "/api/v1/gateway/withdrawals" && method === "GET") {
      return writeJson(response, 200, {
        items: state.withdrawals,
        total: state.withdrawals.length,
        limit: 10,
        offset: 0
      });
    }
    if (url.pathname === "/api/v1/gateway/notifications/unread-count" && method === "GET") {
      return writeJson(response, 200, {
        unreadCount: state.notifications.filter((item) => !item.readAt).length
      });
    }
    if (url.pathname === "/api/v1/gateway/notifications/read-all" && method === "POST") {
      state.readAllCount += 1;
      for (const item of state.notifications) {
        item.readAt = "2026-03-10T10:09:00.000Z";
      }
      return writeJson(response, 200, { updated: 1, readAt: "2026-03-10T10:09:00.000Z", unreadCount: 0 });
    }
    if (url.pathname === "/api/v1/gateway/ledger/entries" && method === "GET") {
      state.statementQueries.push(url.search);
      const category = url.searchParams.get("category");
      const items = state.statementLines.filter((item) => !category || item.category === category);
      return writeJson(response, 200, {
        accountId: "acct-spot-1",
        items,
        total: items.length,
        limit: Number(url.searchParams.get("limit") ?? "20"),
        offset: 0,
        balanceDerivable: { USDT: true }
      });
    }
    if (url.pathname === "/api/v1/gateway/notifications" && method === "GET") {
      return writeJson(response, 200, {
        items: state.notifications,
        total: state.notifications.length,
        limit: 10,
        offset: 0
      });
    }
    if (url.pathname === "/api/v1/gateway/orders" && method === "POST") {
      const body = (await readJson(request)) as Record<string, string>;
      state.orderCounter += 1;
      const order = {
        orderId: `order-${state.orderCounter}`,
        market: body.market,
        side: body.side,
        type: body.type,
        timeInForce: body.timeInForce,
        quantity: body.quantity,
        price: body.price ?? "3200",
        filledQuantity: "0",
        status: "accepted",
        createdAt: "2026-03-10T10:05:00.000Z",
        updatedAt: "2026-03-10T10:05:00.000Z"
      };
      state.orders = [order];
      state.accountEvents = [
        {
          entityType: "order",
          entityId: order.orderId,
          updatedAt: "2026-03-10T10:05:00.000Z"
        },
        ...state.accountEvents
      ];
      return writeJson(response, 200, order);
    }
    if (/^\/api\/v1\/gateway\/orders\/[^/]+\/cancel$/.test(url.pathname) && method === "POST") {
      const orderId = url.pathname.split("/")[5];
      const order = state.orders.find((item) => item.orderId === orderId);
      if (order) {
        order.status = "cancelled";
        order.updatedAt = "2026-03-10T10:06:00.000Z";
      }
      return writeJson(response, 200, order ?? { orderId, status: "cancelled" });
    }
    if (url.pathname === "/api/v1/gateway/deposit-addresses" && method === "GET") {
      return writeJson(response, 200, {
        items: [
          {
            ledgerAccountId: "acct-spot-1",
            assetCode: "ETH",
            network: "ethereum",
            address: "0xethdeposit456",
            status: "active"
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      });
    }
    if (url.pathname === "/api/v1/gateway/deposit-addresses" && method === "POST") {
      const body = (await readJson(request)) as Record<string, string>;
      const deposit = {
        depositId: "deposit-1",
        status: "pending",
        amount: "0",
        network: body.network
      };
      state.deposits = [deposit];
      return writeJson(response, 200, {
        assetCode: body.assetCode,
        network: body.network,
        address: "0xdeposit123"
      });
    }
    if (url.pathname === "/api/v1/gateway/withdrawals/validate" && method === "POST") {
      const body = await readJson(request);
      return writeJson(response, 200, {
        status: "validated",
        ...(body as Record<string, unknown>)
      });
    }
    if (url.pathname === "/api/v1/gateway/withdrawals/request" && method === "POST") {
      const body = (await readJson(request)) as Record<string, string>;
      const withdrawal = {
        withdrawalId: "withdrawal-1",
        status: "requested",
        amount: body.amount,
        network: body.network
      };
      state.withdrawals = [withdrawal];
      state.notifications = [
        {
          notificationId: "notif-1",
          eventType: "withdrawal.requested",
          status: "pending",
          createdAt: "2026-03-10T10:07:00.000Z"
        }
      ];
      state.accountEvents = [
        {
          entityType: "resume",
          entityId: "resume-1",
          updatedAt: "2026-03-10T10:07:00.000Z"
        },
        ...state.accountEvents
      ];
      setTimeout(() => {
        gatewayStateReconnectTrigger.get(state)?.();
      }, 200);
      return writeJson(response, 200, withdrawal);
    }

    return writeJson(response, 404, {
      message: `${method} ${url.pathname} not mocked`
    });
  });
}

function createMarketHttpServer(state: ReturnType<typeof createMarketState>): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/v1/market-data/tickers") {
      return writeJson(response, 200, state.tickers);
    }
    if (url.pathname === "/api/v1/market-data/depth") {
      return writeJson(response, 200, state.depth);
    }
    if (url.pathname === "/api/v1/market-data/trades") {
      return writeJson(response, 200, state.trades);
    }
    if (url.pathname === "/api/v1/market-data/klines") {
      return writeJson(response, 200, []);
    }
    if (url.pathname === "/api/v1/market-data/analytics") {
      return writeJson(response, 200, state.analytics);
    }

    return writeJson(response, 404, {
      message: `GET ${url.pathname} not mocked`
    });
  });
}

function createGatewayRealtimeHarness(state: MockGatewayState, server: Server) {
  const wss = new WebSocketServer({
    server,
    path: "/api/v1/gateway/realtime"
  });
  let sequence = 1;
  let connectionCount = 0;

  const sendFrame = (
    socket: WebSocket,
    type: "snapshot" | "event",
    channel: string,
    items: Record<string, unknown>[]
  ) => {
    socket.send(
      JSON.stringify({
        type,
        channel,
        sequence: sequence++,
        items
      })
    );
  };

  const sendInitialSnapshots = (socket: WebSocket) => {
    sendFrame(socket, "snapshot", "orders", state.orders);
    sendFrame(socket, "snapshot", "trades", state.trades);
    sendFrame(socket, "snapshot", "balances", state.balances);
    sendFrame(socket, "snapshot", "notifications", state.notifications);
    sendFrame(socket, "snapshot", "deposits", state.deposits);
    sendFrame(socket, "snapshot", "withdrawals", state.withdrawals);
    sendFrame(socket, "snapshot", "account_events", state.accountEvents);
  };

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    connectionCount += 1;
    // Like the real gateway: the trader-web Web Host proxies the socket and
    // authenticates the upgrade with the cookie session as a bearer header.
    if (request.headers.authorization?.startsWith("Bearer ")) {
      state.wsBearerSeen = true;
      socket.send(JSON.stringify({ type: "authenticated" }));
    }
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as {
        type: string;
      };

      if (message.type === "auth") {
        socket.send(
          JSON.stringify({
            type: "authenticated"
          })
        );
        return;
      }

      if (message.type === "subscribe") {
        sendInitialSnapshots(socket);
        return;
      }

      if (message.type === "resume") {
        state.reconnectObserved = connectionCount > 1;
        sendFrame(socket, "event", "account_events", [
          {
            entityType: "resume",
            entityId: "resume-1",
            updatedAt: "2026-03-10T10:08:00.000Z"
          }
        ]);
      }
    });
  });

  const triggerReconnect = () => {
    for (const client of wss.clients) {
      client.close();
    }
  };

  gatewayStateReconnectTrigger.set(state, triggerReconnect);

  return {
    async close() {
      gatewayStateReconnectTrigger.delete(state);
      for (const client of wss.clients) {
        closeSocket(client);
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function createMarketRealtimeHarness(
  state: ReturnType<typeof createMarketState>,
  server: Server
) {
  const wss = new WebSocketServer({
    server,
    path: "/api/v1/market-data/ws"
  });

  wss.on("connection", (socket: WebSocket) => {
    socket.send(
      JSON.stringify({
        type: "ready"
      })
    );
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === "subscribe") {
        socket.send(
          JSON.stringify({
            type: "snapshot",
            channel: "ticker",
            item: state.tickers[0]
          })
        );
        socket.send(
          JSON.stringify({
            type: "snapshot",
            channel: "depth",
            item: state.depth
          })
        );
        socket.send(
          JSON.stringify({
            type: "snapshot",
            channel: "trades",
            items: state.trades
          })
        );
      }
    });
  });

  return {
    async close() {
      for (const client of wss.clients) {
        closeSocket(client);
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

const gatewayStateReconnectTrigger = new WeakMap<MockGatewayState, () => void>();

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function writeJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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

function closeSocket(socket: WebSocket): void {
  const candidate = socket as WebSocket & { terminate?: () => void };
  if (typeof candidate.terminate === "function") {
    candidate.terminate();
    return;
  }
  socket.close();
}

function readAddress(server: Server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

async function waitForAttribute(page: Page, selector: string, name: string, value: string) {
  await page.waitForFunction(
    ({ currentSelector, attribute, expected }) =>
      document.querySelector(currentSelector)?.getAttribute(attribute) === expected,
    { currentSelector: selector, attribute: name, expected: value },
    { timeout: 15_000 }
  );
}

async function waitForText(page: Page, selector: string, text: string) {
  await page.waitForFunction(
    ({ selector: innerSelector, text: innerText }) =>
      document.querySelector(innerSelector)?.textContent?.includes(innerText) ?? false,
    {
      selector,
      text
    }
  );
}

async function waitForTableText(
  page: Page,
  selector: string,
  text: string
) {
  await page.waitForFunction(
    ({ selector: innerSelector, text: innerText }) =>
      document.querySelector(innerSelector)?.textContent?.includes(innerText) ?? false,
    {
      selector,
      text
    }
  );
}

async function waitForStatusFeed(page: Page, text: string) {
  await waitForTableText(page, "#status-feed", text);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 15_000
) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for smoke test condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}
