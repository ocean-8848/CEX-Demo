import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { maybeBuildInternalServiceHeaders } from "./internal-service-auth.mjs";
import {
  DEFAULT_SPOT_MARKET,
  buildDepositSourceFloors,
  formatPrice,
  formatQuantity,
  getSpotMarketDefinition,
  listSpotMarkets
} from "./market-config.mjs";

const pgRequire = createRequire(
  new URL("../services/ledger-service/package.json", import.meta.url)
);
const redisRequire = createRequire(
  new URL("../services/order-service/package.json", import.meta.url)
);
const pgModule = await import(pgRequire.resolve("pg"));
const { createClient: createRedisClient } = await import(redisRequire.resolve("redis"));
const PgClient =
  pgModule.Client ??
  pgModule.default?.Client ??
  pgModule["module.exports"]?.Client;
const execFileAsync = promisify(execFile);

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Default market from config/markets.json (override with DEMO_MARKET).
export const DEMO_MARKET = DEFAULT_SPOT_MARKET;
export const DEMO_NETWORK = "ethereum";
export const DEMO_WITHDRAWAL_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
export const DEMO_WITHDRAWAL_ADDRESS_LABEL = "Demo Safe Address";
export const DEMO_OPENING_BALANCE_ACCOUNT_ID = "00000000-0000-0000-0000-000000000090";
const DEFAULT_MARKET_DEFINITION = getSpotMarketDefinition(DEMO_MARKET);
export const DEMO_PRICE_REFERENCE = formatPrice(
  DEFAULT_MARKET_DEFINITION,
  DEFAULT_MARKET_DEFINITION.referencePrice
);

export const DEMO_TRADER = {
  userId: "10000000-0000-0000-0000-000000000201",
  email: "demo-trader@example.com",
  password: "DemoTraderPass123!",
  displayName: "Demo Trader",
  accountId: "20000000-0000-0000-0000-000000000201",
  accountType: "spot"
};

export const DEMO_OPS = {
  userId: "10000000-0000-0000-0000-000000000901",
  email: "ops-admin@example.com",
  password: "OpsAdminPass123!",
  displayName: "Demo Ops Admin",
  roles: ["ops_admin"],
  twoFactorSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
};

// M5-2: second ops approver. Withdrawals above the dual-approval threshold need
// approvals from two different operators (DEMO_OPS + DEMO_OPS_REVIEWER).
export const DEMO_OPS_REVIEWER = {
  userId: "10000000-0000-0000-0000-000000000902",
  email: "ops-reviewer@example.com",
  password: "OpsReviewerPass123!",
  displayName: "Demo Ops Reviewer",
  roles: ["ops_reviewer"],
  twoFactorSecret: "KRUGKIDROVUWG2ZAMJZG653OEBTG66BA"
};

export const DEMO_MAKERS = {
  ask: {
    userId: "10000000-0000-0000-0000-000000000301",
    email: "maker-ask@example.com",
    password: "MakerAskPass123!",
    displayName: "Maker Ask",
    accountId: "20000000-0000-0000-0000-000000000301",
    accountType: "spot"
  },
  bid: {
    userId: "10000000-0000-0000-0000-000000000302",
    email: "maker-bid@example.com",
    password: "MakerBidPass123!",
    displayName: "Maker Bid",
    accountId: "20000000-0000-0000-0000-000000000302",
    accountType: "spot"
  }
};

// Seeded resting orders around the market reference price (for ETH-USDT at
// 3200: asks 3200 / 3210, bids 3190 / 3180), so the demo book is never empty.
const DEMO_LIQUIDITY_LEVELS = [
  { owner: DEMO_MAKERS.ask, orderId: "30000000-0000-0000-0000-000000000311", side: "sell", priceRatio: 1, quantityFactor: 2500 },
  { owner: DEMO_MAKERS.ask, orderId: "30000000-0000-0000-0000-000000000312", side: "sell", priceRatio: 1.003125, quantityFactor: 3000 },
  { owner: DEMO_MAKERS.bid, orderId: "30000000-0000-0000-0000-000000000321", side: "buy", priceRatio: 0.996875, quantityFactor: 2000 },
  { owner: DEMO_MAKERS.bid, orderId: "30000000-0000-0000-0000-000000000322", side: "buy", priceRatio: 0.99375, quantityFactor: 2500 }
];

export function buildDemoLiquidityOrders(market = DEMO_MARKET) {
  const definition = getSpotMarketDefinition(market);
  if (!definition) {
    throw new Error(`Demo market ${market} is not in config/markets.json`);
  }
  const reference = Number(definition.referencePrice);
  return DEMO_LIQUIDITY_LEVELS.map((level) => ({
    owner: level.owner,
    orderId: level.orderId,
    side: level.side,
    price: formatPrice(definition, reference * level.priceRatio),
    // quantityFactor x minQuantity (ETH-USDT: 2500 x 0.001 = 2.500)
    quantity: formatQuantity(definition, Number(definition.minQuantity) * level.quantityFactor),
    timeInForce: "gtc"
  }));
}

/** Base / quote assets of the demo market (ETH / USDT by default). */
export function demoMarketAssets(config = loadDemoConfig()) {
  const definition = getSpotMarketDefinition(config.demoMarket);
  if (!definition) {
    throw new Error(`Demo market ${config.demoMarket} is not in config/markets.json`);
  }
  return { baseAsset: definition.baseAsset, quoteAsset: definition.quoteAsset };
}

const RESET_TABLES = [
  "proof_of_reserves_leaves",
  "proof_of_reserves_snapshots",
  "treasury_sweep_deposits",
  "treasury_transfers",
  "risk_market_status_overrides",
  "risk_surveillance_alert_events",
  "risk_surveillance_alerts",
  "spot_fee_tier_override_audit",
  "spot_fee_tier_overrides",
  "ops_action_audit_logs",
  "wallet_notifications",
  "withdrawal_audit_logs",
  "withdrawal_address_book",
  "withdrawals",
  "deposits",
  "wallet_addresses",
  "trade_event_consumer_checkpoints",
  "settlement_automation_executions",
  "trade_settlement_summary_rollups",
  "trade_settlement_recovery_jobs",
  "trade_settlements",
  "spot_order_automation_executions",
  "spot_order_recovery_jobs",
  "spot_trades",
  "spot_orders",
  "blockchain_withdrawal_observations",
  "blockchain_deposit_observations",
  "blockchain_scan_cursors",
  "custody_transfer_attempts",
  "custody_transfers",
  "outbox_events",
  "balance_locks",
  "ledger_entries",
  "ledger_journals",
  "balances",
  "accounts",
  "identity_login_events",
  "identity_user_devices",
  "identity_kyc_events",
  "identity_kyc_requests",
  "identity_two_factor_recovery_codes",
  "identity_api_keys",
  "identity_ops_sessions",
  "identity_user_roles",
  "identity_user_credentials",
  "user_two_factor_profiles",
  "identity_users"
];

const CLICKHOUSE_TABLES = [
  "market_data_trade_snapshots",
  "market_data_depth_snapshots",
  "market_data_ticker_snapshots",
  "market_data_kline_1m"
];

export function loadDemoConfig(env = process.env) {
  return {
    databaseUrl: env.DEMO_DATABASE_URL ?? env.DATABASE_URL ?? "postgres://web3:web3@127.0.0.1:5432/web3_cex",
    redisUrl: env.DEMO_REDIS_URL ?? env.ORDER_EVENT_REDIS_URL ?? "redis://127.0.0.1:6379",
    clickhouseUrl: env.DEMO_CLICKHOUSE_URL ?? env.MARKET_DATA_CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
    clickhouseDatabase: env.DEMO_CLICKHOUSE_DATABASE ?? env.MARKET_DATA_CLICKHOUSE_DATABASE ?? "default",
    clickhouseUser: env.DEMO_CLICKHOUSE_USER ?? env.MARKET_DATA_CLICKHOUSE_USER ?? "",
    clickhousePassword: env.DEMO_CLICKHOUSE_PASSWORD ?? env.MARKET_DATA_CLICKHOUSE_PASSWORD ?? "",
    clickhouseContainer: env.DEMO_CLICKHOUSE_CONTAINER ?? "web3-cex-clickhouse",
    identityBaseUrl: env.DEMO_IDENTITY_URL ?? "http://127.0.0.1:3005",
    ledgerBaseUrl: env.DEMO_LEDGER_URL ?? "http://127.0.0.1:3001",
    walletBaseUrl: env.DEMO_WALLET_URL ?? "http://127.0.0.1:3002",
    indexerBaseUrl: env.DEMO_INDEXER_URL ?? "http://127.0.0.1:3003",
    orderBaseUrl: env.DEMO_ORDER_URL ?? "http://127.0.0.1:3009",
    settlementBaseUrl: env.DEMO_SETTLEMENT_URL ?? "http://127.0.0.1:3010",
    gatewayBaseUrl: env.DEMO_GATEWAY_URL ?? "http://127.0.0.1:3007",
    marketDataBaseUrl: env.DEMO_MARKET_DATA_URL ?? "http://127.0.0.1:3012",
    opsConsoleBaseUrl: env.DEMO_OPS_CONSOLE_URL ?? "http://127.0.0.1:3006",
    demoSimulatorBaseUrl: env.DEMO_SIMULATOR_URL ?? "http://127.0.0.1:3014",
    riskBaseUrl: env.DEMO_RISK_URL ?? "http://127.0.0.1:3008",
    walletDepositSourceAccountId:
      env.DEMO_LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
      env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
      "00000000-0000-0000-0000-000000000098",
    walletWithdrawalSettlementAccountId:
      env.DEMO_LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID ??
      env.LEDGER_WITHDRAWAL_SETTLEMENT_ACCOUNT_ID ??
      env.DEMO_LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
      env.LEDGER_DEPOSIT_SOURCE_ACCOUNT_ID ??
      "00000000-0000-0000-0000-000000000098",
    matchingEngineHost: env.DEMO_MATCHING_ENGINE_HOST ?? env.MATCHING_ENGINE_HOST ?? "127.0.0.1",
    matchingEnginePort: Number(env.DEMO_MATCHING_ENGINE_PORT ?? env.MATCHING_ENGINE_PORT ?? "3011"),
    demoMarket: env.DEMO_MARKET ?? DEMO_MARKET,
    demoNetwork: env.DEMO_NETWORK ?? DEMO_NETWORK,
    withdrawalAddress: env.DEMO_WITHDRAWAL_ADDRESS ?? DEMO_WITHDRAWAL_ADDRESS,
    clickhouseTimeoutMs: Number(
      env.DEMO_CLICKHOUSE_TIMEOUT_MS ?? env.MARKET_DATA_CLICKHOUSE_TIMEOUT_MS ?? "5000"
    )
  };
}

export async function resetDemoState(
  config = loadDemoConfig(),
  options = {}
) {
  const warnings = [];
  let truncatedTables = [];
  // An in-flight settlement batch that finishes after the truncation would write
  // a stale consumer checkpoint (and settle trades whose accounts are gone), so
  // let the async consumers catch up first.
  const drained = await waitForSettlementDrain(config);
  if (!drained) {
    warnings.push("settlement consumer did not drain before reset");
  }
  const client = new PgClient({
    connectionString: config.databaseUrl
  });
  await client.connect();

  try {
    const tables = await resolveExistingTables(client, RESET_TABLES);
    if (tables.length > 0) {
      await client.query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    }
    truncatedTables = tables;
    options.onResetTables?.(tables);
  } finally {
    await client.end();
  }

  try {
    await clearRedisNamespace(config.redisUrl, "web3-cex:*");
  } catch (error) {
    warnings.push(`redis cleanup skipped: ${readErrorMessage(error)}`);
  }

  try {
    await clearClickHouseTables(config, CLICKHOUSE_TABLES);
  } catch (error) {
    warnings.push(`clickhouse cleanup skipped: ${readErrorMessage(error)}`);
  }

  // Every configured market (delisted too: its book may still hold orders).
  for (const market of [...new Set([...listSpotMarkets({ includeDelisted: true }), config.demoMarket])]) {
    try {
      // Trades and streams were wiped, so sequences restart at 1 as well.
      await sendMatchingEngineCommand(config, {
        action: "reset",
        market,
        reset_sequences: true
      });
    } catch (error) {
      warnings.push(`matching-engine reset skipped for ${market}: ${readErrorMessage(error)}`);
    }
  }

  return {
    status: "ok",
    resetTables: truncatedTables.length,
    warnings
  };
}

export async function bootstrapStandardDemo(
  config = loadDemoConfig(),
  options = {}
) {
  await assertDemoServiceAvailability(config, [
    ["identity-service", `${config.identityBaseUrl}/api/v1/identity/users?limit=1`],
    ["ledger-service", `${config.ledgerBaseUrl}/api/v1/ledger/balances?limit=1`],
    ["wallet-service", `${config.walletBaseUrl}/api/v1/wallet/deposit-addresses?limit=1`],
    ["order-service", `${config.orderBaseUrl}/api/v1/orders?userId=probe&limit=1`],
    ["settlement-service", `${config.settlementBaseUrl}/api/v1/settlement/trades?limit=1`]
  ]);
  await assertMatchingEngineAvailable(config);

  const trader = await ensureIdentityUser(config, DEMO_TRADER);
  const askMaker = await ensureIdentityUser(config, DEMO_MAKERS.ask);
  const bidMaker = await ensureIdentityUser(config, DEMO_MAKERS.bid);
  const opsUser = await ensureIdentityUser(config, {
    ...DEMO_OPS,
    userType: "ops"
  });

  await setEnabledTwoFactorProfile(config, {
    userId: DEMO_OPS.userId,
    label: DEMO_OPS.email,
    secret: DEMO_OPS.twoFactorSecret
  });
  await ensureIdentityUser(config, {
    ...DEMO_OPS_REVIEWER,
    userType: "ops"
  });
  await setEnabledTwoFactorProfile(config, {
    userId: DEMO_OPS_REVIEWER.userId,
    label: DEMO_OPS_REVIEWER.email,
    secret: DEMO_OPS_REVIEWER.twoFactorSecret
  });

  await ensureLedgerAccount(config, {
    accountId: DEMO_OPENING_BALANCE_ACCOUNT_ID,
    accountType: "opening_balance"
  });
  await ensureLedgerAccount(config, {
    accountId: config.walletDepositSourceAccountId,
    accountType: "treasury"
  });
  if (config.walletWithdrawalSettlementAccountId !== config.walletDepositSourceAccountId) {
    await ensureLedgerAccount(config, {
      accountId: config.walletWithdrawalSettlementAccountId,
      accountType: "treasury"
    });
  }
  await ensureOpeningBalanceLiquidity(config, {
    accountId: DEMO_OPENING_BALANCE_ACCOUNT_ID
  });
  await ensureLedgerAccount(config, {
    accountId: DEMO_TRADER.accountId,
    userId: trader.userId,
    accountType: DEMO_TRADER.accountType
  });
  await ensureLedgerAccount(config, {
    accountId: DEMO_MAKERS.ask.accountId,
    userId: askMaker.userId,
    accountType: DEMO_MAKERS.ask.accountType
  });
  await ensureLedgerAccount(config, {
    accountId: DEMO_MAKERS.bid.accountId,
    userId: bidMaker.userId,
    accountType: DEMO_MAKERS.bid.accountType
  });

  const { baseAsset, quoteAsset } = demoMarketAssets(config);
  await ensureBalanceFloor(config, {
    accountId: DEMO_TRADER.accountId,
    assetCode: quoteAsset,
    minimumAvailable: "25000",
    businessPrefix: `demo_trader_${quoteAsset.toLowerCase()}_seed`
  });
  await ensureBalanceFloor(config, {
    accountId: DEMO_TRADER.accountId,
    assetCode: baseAsset,
    minimumAvailable: "5",
    businessPrefix: `demo_trader_${baseAsset.toLowerCase()}_seed`
  });
  await ensureMakerSeedBalances(config);
  // Treasury the wallet credits deposits from: one floor per configured asset.
  for (const { assetCode, floor } of buildDepositSourceFloors()) {
    await ensureBalanceFloor(config, {
      accountId: config.walletDepositSourceAccountId,
      assetCode,
      minimumAvailable: floor,
      businessPrefix: `demo_wallet_deposit_source_${assetCode.toLowerCase()}_seed`
    });
  }

  const depositAddresses = await Promise.all(
    [quoteAsset, baseAsset].map((assetCode) =>
      ensureDepositAddress(config, {
        userId: DEMO_TRADER.userId,
        ledgerAccountId: DEMO_TRADER.accountId,
        assetCode,
        network: config.demoNetwork
      })
    )
  );

  const addressBookEntry = await ensureWithdrawalWhitelistEntry(config, {
    userId: DEMO_TRADER.userId,
    network: config.demoNetwork,
    address: config.withdrawalAddress,
    label: DEMO_WITHDRAWAL_ADDRESS_LABEL
  });

  await ensureDemoLiquidity(config);

  // Custody layering: back the opening-balance seeding with on-chain hot / cold
  // wallet funds so the wallet-vs-ledger reconciliation starts out covered.
  try {
    const { ensureTreasuryReserves } = await import("./treasury-demo-lib.mjs");
    await ensureTreasuryReserves(config, { fundHot: true, referencePrefix: "demo_bootstrap" });
  } catch (error) {
    console.warn(`[bootstrap] treasury reserves not seeded: ${readErrorMessage(error)}`);
  }

  const opsTwoFactor = generateTotpCode(DEMO_OPS.twoFactorSecret, new Date());
  return {
    status: "ok",
    market: config.demoMarket,
    network: config.demoNetwork,
    trader: {
      email: DEMO_TRADER.email,
      password: DEMO_TRADER.password,
      userId: DEMO_TRADER.userId,
      accountId: DEMO_TRADER.accountId,
      depositAddresses,
      withdrawalAddressBook: addressBookEntry
    },
    ops: {
      email: DEMO_OPS.email,
      password: DEMO_OPS.password,
      userId: DEMO_OPS.userId,
      roles: DEMO_OPS.roles,
      twoFactorSecret: DEMO_OPS.twoFactorSecret,
      currentTwoFactorCode: opsTwoFactor.code,
      currentTwoFactorCounter: opsTwoFactor.counter
    },
    opsReviewer: {
      email: DEMO_OPS_REVIEWER.email,
      password: DEMO_OPS_REVIEWER.password,
      userId: DEMO_OPS_REVIEWER.userId,
      roles: DEMO_OPS_REVIEWER.roles,
      twoFactorSecret: DEMO_OPS_REVIEWER.twoFactorSecret
    },
    makers: {
      ask: DEMO_MAKERS.ask.accountId,
      bid: DEMO_MAKERS.bid.accountId
    }
  };
}

export async function verifyStandardDemo(config = loadDemoConfig()) {
  await assertDemoServiceAvailability(config, [
    ["gateway", `${config.gatewayBaseUrl}/api/v1/gateway/auth/me`],
    ["market-data-service", `${config.marketDataBaseUrl}/api/v1/market-data/tickers`],
    ["ops-console", `${config.opsConsoleBaseUrl}/api/v1/ops/auth/me`]
  ]);

  await bootstrapStandardDemo(config);

  const customerSession = await fetchJson(
    `${config.gatewayBaseUrl}/api/v1/gateway/auth/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        email: DEMO_TRADER.email,
        password: DEMO_TRADER.password
      })
    }
  );

  const balances = await fetchJson(
    `${config.gatewayBaseUrl}/api/v1/gateway/balances?limit=20&offset=0`,
    {
      headers: {
        authorization: `Bearer ${customerSession.token}`
      }
    }
  );
  const depositAddresses = await fetchJson(
    `${config.gatewayBaseUrl}/api/v1/gateway/deposit-addresses?limit=20&offset=0`,
    {
      headers: {
        authorization: `Bearer ${customerSession.token}`
      }
    }
  );
  const depth = await fetchJson(
    `${config.marketDataBaseUrl}/api/v1/market-data/depth?market=${encodeURIComponent(
      config.demoMarket
    )}&limit=10`
  );
  const tickers = await fetchJson(`${config.marketDataBaseUrl}/api/v1/market-data/tickers`);

  const opsSession = await fetchJson(`${config.opsConsoleBaseUrl}/api/v1/ops/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      email: DEMO_OPS.email,
      password: DEMO_OPS.password,
      twoFactorCode: generateTotpCode(DEMO_OPS.twoFactorSecret, new Date()).code
    })
  });
  const modules = await fetchJson(`${config.opsConsoleBaseUrl}/api/v1/ops/modules`, {
    headers: {
      authorization: `Bearer ${opsSession.token}`
    }
  });

  const balanceItems = normalizePaged(balances).items;
  const depositItems = normalizePaged(depositAddresses).items;
  const { quoteAsset } = demoMarketAssets(config);
  const traderUsdt = balanceItems.find(
    (item) => item.accountId === DEMO_TRADER.accountId && item.assetCode === quoteAsset
  );
  const ticker = Array.isArray(tickers)
    ? tickers.find((item) => item.market === config.demoMarket)
    : null;

  assert.ok(traderUsdt, "Demo trader USDT balance not found");
  assert.ok(Number(traderUsdt.available ?? "0") >= 25000, "Demo trader USDT balance below floor");
  assert.ok(
    depositItems.some((item) => item.assetCode === quoteAsset && item.network === config.demoNetwork),
    "Demo trader USDT deposit address missing"
  );
  assert.ok(Array.isArray(depth.bids) && depth.bids.length > 0, "Demo market bids are empty");
  assert.ok(Array.isArray(depth.asks) && depth.asks.length > 0, "Demo market asks are empty");
  assert.ok(ticker?.market === config.demoMarket, "Demo market ticker is unavailable");
  assert.ok(Array.isArray(modules) && modules.length >= 11, "Ops module navigation is incomplete");

  return {
    status: "ok",
    market: config.demoMarket,
    balances: {
      count: balanceItems.length,
      traderUsdtAvailable: traderUsdt.available
    },
    depositAddresses: depositItems.length,
    depth: {
      bids: depth.bids.length,
      asks: depth.asks.length
    },
    ticker,
    opsModules: modules.length
  };
}

export async function ensureDemoLiquidity(config = loadDemoConfig()) {
  await ensureLedgerAccount(config, {
    accountId: DEMO_MAKERS.ask.accountId,
    userId: DEMO_MAKERS.ask.userId,
    accountType: DEMO_MAKERS.ask.accountType
  });
  await ensureLedgerAccount(config, {
    accountId: DEMO_MAKERS.bid.accountId,
    userId: DEMO_MAKERS.bid.userId,
    accountType: DEMO_MAKERS.bid.accountType
  });
  await ensureMakerSeedBalances(config);
  const liquidityOrders = buildDemoLiquidityOrders(config.demoMarket);

  const existingOrders = await listOrders(config, {
    market: config.demoMarket,
    limit: 100,
    offset: 0
  });

  for (const spec of liquidityOrders) {
    const exists = existingOrders.some(
      (order) =>
        order.accountId === spec.owner.accountId &&
        order.market === config.demoMarket &&
        order.side === spec.side &&
        order.price === spec.price &&
        ["accepted", "partially_filled"].includes(order.status ?? "")
    );

    if (exists) {
      continue;
    }

    await createSpotOrder(config, {
      userId: spec.owner.userId,
      accountId: spec.owner.accountId,
      market: config.demoMarket,
      side: spec.side,
      type: "limit",
      timeInForce: spec.timeInForce,
      price: spec.price,
      quantity: spec.quantity,
      idempotencyKey: `demo-liquidity:${spec.orderId}`
    });
  }

  return {
    status: "ok",
    market: config.demoMarket,
    restingOrders: liquidityOrders.length
  };
}

export async function ensureLedgerAccount(config, payload) {
  try {
    return await fetchJson(
      `${config.ledgerBaseUrl}/api/v1/ledger/accounts/${encodeURIComponent(payload.accountId)}`
    );
  } catch (error) {
    if (!isHttpStatus(error, 404)) {
      throw error;
    }
  }

  return fetchJson(`${config.ledgerBaseUrl}/api/v1/ledger/accounts`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function ensureBalanceFloor(
  config,
  {
    accountId,
    assetCode,
    minimumAvailable,
    businessPrefix,
    sourceAccountId = DEMO_OPENING_BALANCE_ACCOUNT_ID
  }
) {
  await ensureLedgerAccount(config, {
    accountId: sourceAccountId,
    accountType: "opening_balance"
  });

  const balance = await getBalanceOrZero(config, accountId, assetCode);
  if (Number(balance.available ?? "0") >= Number(minimumAvailable)) {
    return balance;
  }

  const amount = formatAmount(Number(minimumAvailable) - Number(balance.available ?? "0"));
  const now = new Date().toISOString();
  const businessId = `${businessPrefix}:${accountId}:${assetCode}`;

  await fetchJson(`${config.ledgerBaseUrl}/api/v1/ledger/journals`, {
    method: "POST",
    body: JSON.stringify({
      businessType: businessPrefix,
      businessId,
      // Each top-up moves a different amount; the ledger answers a reused key
      // with a different payload with 409 DUPLICATE_IDEMPOTENCY_KEY.
      idempotencyKey: `${businessId}:${now}`,
      traceId: `${businessPrefix}:${accountId}:${assetCode}`,
      description: `Seed ${assetCode} for ${accountId}`,
      entries: [
        {
          accountId: sourceAccountId,
          assetCode,
          direction: "debit",
          amount,
          referenceType: businessPrefix,
          referenceId: `${accountId}:source:${now}`
        },
        {
          accountId,
          assetCode,
          direction: "credit",
          amount,
          referenceType: businessPrefix,
          referenceId: `${accountId}:target:${now}`
        }
      ]
    })
  });

  return getBalanceOrZero(config, accountId, assetCode);
}

// The opening-balance account is an equity account: the ledger lets it go
// negative, so seeding funds is just a balanced journal from it (see
// ensureBalanceFloor). It used to be topped up with a direct SQL update, which
// created balances without journals and broke reconciliation.
export async function ensureOpeningBalanceLiquidity(config, { accountId }) {
  await ensureLedgerAccount(config, {
    accountId,
    accountType: "opening_balance"
  });
  return getBalanceOrZero(config, accountId, demoMarketAssets(config).quoteAsset);
}

// Ask maker holds base, bid maker holds quote of the demo market (the
// simulator tops up the other configured markets on its own).
async function ensureMakerSeedBalances(config) {
  const { baseAsset, quoteAsset } = demoMarketAssets(config);
  await ensureBalanceFloor(config, {
    accountId: DEMO_MAKERS.ask.accountId,
    assetCode: baseAsset,
    minimumAvailable: "40",
    businessPrefix: `demo_maker_ask_${baseAsset.toLowerCase()}_seed`
  });
  await ensureBalanceFloor(config, {
    accountId: DEMO_MAKERS.bid.accountId,
    assetCode: quoteAsset,
    minimumAvailable: "150000",
    businessPrefix: `demo_maker_bid_${quoteAsset.toLowerCase()}_seed`
  });
}

export async function ensureDepositAddress(
  config,
  {
    userId,
    ledgerAccountId,
    assetCode,
    network
  }
) {
  const existing = normalizePaged(
    await fetchJson(
      `${config.walletBaseUrl}/api/v1/wallet/deposit-addresses?${new URLSearchParams({
        userId,
        ledgerAccountId,
        assetCode,
        network,
        limit: "10",
        offset: "0"
      }).toString()}`
    )
  ).items[0];
  if (existing) {
    return existing;
  }

  return fetchJson(`${config.walletBaseUrl}/api/v1/wallet/deposit-addresses`, {
    method: "POST",
    body: JSON.stringify({
      userId,
      ledgerAccountId,
      assetCode,
      network
    })
  });
}

export async function ensureWithdrawalWhitelistEntry(
  config,
  {
    userId,
    network,
    address,
    label
  }
) {
  const payload = normalizePaged(
    await fetchJson(
      `${config.walletBaseUrl}/api/v1/wallet/withdrawal-address-book?${new URLSearchParams({
        userId,
        network,
        address,
        limit: "10",
        offset: "0"
      }).toString()}`
    )
  );
  const existing = payload.items[0];
  if (existing?.isWhitelisted) {
    return existing;
  }

  const entry =
    existing ??
    (await fetchJson(`${config.walletBaseUrl}/api/v1/wallet/withdrawal-address-book`, {
      method: "POST",
      body: JSON.stringify({
        userId,
        network,
        address,
        label,
        isWhitelisted: true
      })
    }));

  if (!entry.isWhitelisted) {
    return fetchJson(
      `${config.walletBaseUrl}/api/v1/wallet/withdrawal-address-book/${encodeURIComponent(
        entry.addressBookId
      )}/whitelist`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  }

  return entry;
}

export async function ensureIdentityUser(config, user) {
  const byId = normalizePaged(
    await fetchJson(
      `${config.identityBaseUrl}/api/v1/identity/users?${new URLSearchParams({
        userId: user.userId,
        limit: "1",
        offset: "0"
      }).toString()}`
    )
  ).items[0];
  if (byId) {
    return byId;
  }

  const byEmail = user.email
    ? normalizePaged(
        await fetchJson(
          `${config.identityBaseUrl}/api/v1/identity/users?${new URLSearchParams({
            email: user.email,
            limit: "1",
            offset: "0"
          }).toString()}`
        )
      ).items[0]
    : null;
  if (byEmail && byEmail.userId !== user.userId) {
    throw new Error(
      `Identity user email ${user.email} already belongs to ${byEmail.userId}; run demo reset first`
    );
  }
  if (byEmail) {
    return byEmail;
  }

  return fetchJson(`${config.identityBaseUrl}/api/v1/identity/users`, {
    method: "POST",
    body: JSON.stringify({
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      status: "active",
      userType: user.userType ?? "customer",
      password: user.password,
      roles: user.roles
    })
  });
}

export async function setEnabledTwoFactorProfile(
  config,
  {
    userId,
    label,
    secret,
    issuer = "Web3 CEX"
  }
) {
  const client = new PgClient({
    connectionString: config.databaseUrl
  });
  const now = new Date().toISOString();

  await client.connect();
  try {
    await client.query(
      `insert into user_two_factor_profiles
       (user_id, pending_secret, secret, issuer, label, enabled, enabled_at, last_verified_counter, created_at, updated_at)
       values ($1, null, $2, $3, $4, true, $5, null, $5, $5)
       on conflict (user_id) do update set
         pending_secret = null,
         secret = excluded.secret,
         issuer = excluded.issuer,
         label = excluded.label,
         enabled = true,
         enabled_at = excluded.enabled_at,
         updated_at = excluded.updated_at`,
      [userId, secret, issuer, label, now]
    );
  } finally {
    await client.end();
  }

  return {
    userId,
    label,
    issuer,
    secret
  };
}

export async function waitForSettlementDrain(config, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    try {
      const report = await fetchJson(`${config.settlementBaseUrl}/api/v1/settlement/event-bus`);
      const lagging = (report.checkpointLag ?? []).some(
        (item) => Number(item.executionSequenceLag ?? 0) > 0
      );
      stableChecks = lagging ? 0 : stableChecks + 1;
      // Two consecutive idle reads, so a batch that just started is also finished.
      if (stableChecks >= 2) {
        return true;
      }
    } catch {
      return false;
    }
    await delay(500);
  }
  return false;
}

// Pauses/resumes the demo-simulator market makers (if the simulator is running)
// so scripted flows can trade against the fixed seeded order book.
export async function setDemoMakersPaused(config, paused) {
  try {
    await fetchJson(`${config.demoSimulatorBaseUrl}/api/demo/makers`, {
      method: "POST",
      body: JSON.stringify({ paused })
    });
    return true;
  } catch {
    return false;
  }
}

export async function listOrders(config, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  return fetchJson(`${config.orderBaseUrl}/api/v1/orders?${params.toString()}`);
}

export async function createSpotOrder(config, payload) {
  return fetchJson(`${config.orderBaseUrl}/api/v1/orders`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getBalanceOrZero(config, accountId, assetCode) {
  try {
    return await fetchJson(
      `${config.ledgerBaseUrl}/api/v1/ledger/balances/${encodeURIComponent(
        accountId
      )}/${encodeURIComponent(assetCode)}`
    );
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      return {
        accountId,
        assetCode,
        available: "0",
        locked: "0"
      };
    }

    throw error;
  }
}

export async function waitForCondition(
  label,
  condition,
  {
    timeoutMs = 30_000,
    intervalMs = 1_000
  } = {}
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await condition();
    if (result) {
      return result;
    }
    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

export function generateTotpCode(secret, now, periodSeconds = 30, digits = 6) {
  const counter = Math.floor(now.getTime() / 1000 / periodSeconds);
  return {
    code: hotp(base32Decode(secret), counter, digits),
    counter
  };
}

export async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
        ...maybeBuildInternalServiceHeaders(url, init)
      },
      signal: controller.signal
    });

    if (!response.ok) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = {
          message: await response.text()
        };
      }

      const error = new Error(
        payload?.message ?? `HTTP ${response.status} ${response.statusText}`
      );
      error.httpStatus = response.status;
      throw error;
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizePaged(payload) {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      total: payload.length,
      limit: payload.length,
      offset: 0
    };
  }

  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    total: Number(payload?.total ?? 0),
    limit: Number(payload?.limit ?? 0),
    offset: Number(payload?.offset ?? 0)
  };
}

export function formatAmount(value) {
  return value.toFixed(18).replace(/\.?0+$/, "");
}

async function assertDemoServiceAvailability(config, checks) {
  const failures = [];

  for (const [label, url] of checks) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000)
      });
      if (![200, 400, 401, 403].includes(response.status)) {
        failures.push(`${label} responded with HTTP ${response.status}`);
      }
    } catch (error) {
      failures.push(`${label} is unreachable: ${readErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

async function assertMatchingEngineAvailable(config) {
  const snapshot = await sendMatchingEngineCommand(config, {
    action: "snapshot",
    market: config.demoMarket,
    limit: 1
  });
  assert.ok(snapshot.market === config.demoMarket, "matching-engine snapshot failed");
}

async function resolveExistingTables(client, tables) {
  const values = tables.map((_, index) => `($${index + 1})`).join(", ");
  const result = await client.query(
    `with candidates(table_name) as (values ${values})
     select table_name
     from candidates
     where to_regclass(table_name) is not null`,
    tables
  );
  return result.rows
    .map((row) => row.table_name)
    .filter((value) => typeof value === "string");
}

async function clearRedisNamespace(redisUrl, pattern) {
  const client = createRedisClient({
    url: redisUrl
  });
  await client.connect();

  try {
    const keys = [];
    for await (const item of client.scanIterator({
      MATCH: pattern,
      COUNT: 100
    })) {
      if (Array.isArray(item)) {
        keys.push(...item);
      } else {
        keys.push(item);
      }
    }

    if (keys.length > 0) {
      await client.del(keys);
    }
  } finally {
    await client.quit();
  }
}

async function clearClickHouseTables(config, tables) {
  for (const table of tables) {
    await executeClickHouseQuery(config, `TRUNCATE TABLE IF EXISTS ${table}`);
  }
}

async function executeClickHouseQuery(config, query) {
  try {
    await executeClickHouseHttpQuery(config, query);
    return;
  } catch (httpError) {
    if (!config.clickhouseContainer) {
      throw httpError;
    }

    try {
      await executeClickHouseContainerQuery(config, query);
      return;
    } catch (containerError) {
      throw new Error(
        `http cleanup failed: ${readErrorMessage(httpError)}; docker fallback failed: ${readErrorMessage(containerError)}`
      );
    }
  }
}

async function executeClickHouseHttpQuery(config, query) {
  const url = new URL(config.clickhouseUrl);
  url.searchParams.set("database", config.clickhouseDatabase);
  url.searchParams.set("query", query);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(config.clickhouseUser ? { "x-clickhouse-user": config.clickhouseUser } : {}),
      ...(config.clickhousePassword ? { "x-clickhouse-key": config.clickhousePassword } : {})
    },
    signal: AbortSignal.timeout(config.clickhouseTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function executeClickHouseContainerQuery(config, query) {
  await execFileAsync(
    "docker",
    [
      "exec",
      config.clickhouseContainer,
      "clickhouse-client",
      "--database",
      config.clickhouseDatabase,
      "--query",
      query
    ],
    {
      timeout: config.clickhouseTimeoutMs
    }
  );
}

async function sendMatchingEngineCommand(config, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      {
        host: config.matchingEngineHost,
        port: config.matchingEnginePort
      },
      () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      }
    );

    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000);
    socket.on("timeout", () => {
      socket.destroy(new Error("matching-engine timeout"));
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) {
        socket.end();
        try {
          resolve(JSON.parse(response.trim()));
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.on("error", reject);
  });
}

function hotp(secret, counter, digits) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

function base32Decode(value) {
  let bits = 0;
  let current = 0;
  const bytes = [];

  for (const character of value.replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error(`Invalid base32 character: ${character}`);
    }

    current = (current << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isHttpStatus(error, status) {
  return error instanceof Error && Number(error.httpStatus) === status;
}
