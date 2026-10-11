// Demo simulator: keeps the learning exchange "alive" without a real blockchain.
//
// It plays two external actors that a real CEX depends on but does not own:
//
// 1. Market makers - two maker accounts quote a ladder around a random-walk mid
//    price and occasionally cross the spread, so the order book has depth and
//    the K-line chart has candles.
// 2. The chain - a simulated EVM chain produces a block every DEMO_CHAIN_BLOCK_MS.
//    Pending deposit observations and broadcasted withdrawals gain one
//    confirmation per block and are re-reported to blockchain-indexer, exactly
//    like a real scanner would do. Wallet/ledger then credit or settle them.
//
// It also exposes a tiny faucet API (used by trader-web through /api/demo/*)
// that lets a logged-in user "send" test funds to their own deposit address.
//
// Fault lab (M3-2): /internal/lab/* lets ops-console halt block production and
// trigger a chain reorganisation. Those routes require an HMAC-signed internal
// request (caller ops-console / demo-scripts) and are never proxied by trader-web.

import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import process from "node:process";

import { verifyInternalServiceRequest } from "./internal-service-auth.mjs";
import {
  DEMO_MAKERS,
  DEMO_OPENING_BALANCE_ACCOUNT_ID,
  DEMO_TRADER,
  ensureDepositAddress,
  fetchJson,
  getBalanceOrZero,
  loadDemoConfig,
  normalizePaged
} from "./mvp-demo-lib.mjs";
import {
  buildDepositSourceFloors,
  buildFaucetLimits,
  buildSimulatorMarkets,
  getAssetDefinition,
  listConfiguredNetworks,
  networkForAsset
} from "./market-config.mjs";

const config = loadDemoConfig(process.env);
const PORT = Number(process.env.DEMO_SIMULATOR_PORT ?? "3014");
const MAKER_INTERVAL_MS = Number(process.env.DEMO_MAKER_INTERVAL_MS ?? "2500");
const BLOCK_MS = Number(process.env.DEMO_CHAIN_BLOCK_MS ?? "1500");
const REQUIRED_CONFIRMATIONS = Number(process.env.DEMO_CHAIN_REQUIRED_CONFIRMATIONS ?? "12");
const MAKERS_ENABLED = process.env.DEMO_MAKERS_ENABLED !== "false";
const NETWORK = config.demoNetwork;
const FAULT_LAB_ENABLED = process.env.DEMO_FAULT_LAB_ENABLED !== "false";
const CHAIN_HALT_MAX_MS = Number(process.env.DEMO_CHAIN_HALT_MAX_MS ?? "600000");
const CHAIN_HALT_DEFAULT_MS = Number(process.env.DEMO_CHAIN_HALT_DEFAULT_MS ?? "180000");
const LAB_ALLOWED_CALLERS = ["ops-console", "demo-scripts"];
// A reorg deeper than the confirmation threshold could orphan a deposit that
// was already credited, which the ledger cannot undo; keep it strictly below.
const MAX_REORG_DEPTH = Math.max(REQUIRED_CONFIRMATIONS - 1, 1);

// Markets, assets, faucet limits and maker inventory all come from
// config/markets.json (see scripts/market-config.mjs) - adding a market there
// makes the simulator quote it without code changes.
const FAUCET_LIMITS = buildFaucetLimits(process.env);
const MARKETS = buildSimulatorMarkets(process.env);
// Every network some configured asset lives on is simulated as one chain.
const SIMULATED_NETWORKS = [...new Set([NETWORK, ...listConfiguredNetworks()])];

const LADDER_LEVELS = 10;
const LEVEL_SPACING_RATIO = 0.0004;
const MAX_DRIFT_RATIO = 0.08;

const state = {
  startedAt: new Date().toISOString(),
  blockHeight: 19_000_000 + Math.floor(Math.random() * 10_000),
  makerTicks: 0,
  lastMakerError: null,
  lastChainError: null,
  // txHash -> block number in which the withdrawal was "mined"
  withdrawalBlocks: new Map(),
  faucetCount: 0,
  makersPaused: false,
  makerTickInFlight: null,
  // Set when maker balances may be gone (resume after demo:reset, or an order
  // rejected for balance) so the next tick tops up instead of waiting ~50s.
  makerFundingNeeded: true,
  // Canonical block hashes of recent blocks; a reorg drops the orphaned ones.
  blockHashes: new Map(),
  chainLock: Promise.resolve(),
  chainHalt: null,
  reorgCount: 0,
  lastReorg: null,
  labDepositCount: 0
};

// ---------------------------------------------------------------------------
// Chain simulation
// ---------------------------------------------------------------------------

async function chainTick() {
  if (isChainHalted()) {
    return;
  }
  await withChainLock(async () => {
    state.blockHeight += 1;
    pruneBlockHashes();
    try {
      await advancePendingDeposits();
      await advanceBroadcastedWithdrawals();
      state.lastChainError = null;
    } catch (error) {
      state.lastChainError = readErrorMessage(error);
    }
  });
}

// Serialises block production with fault-lab reorgs so a tick never re-reports
// pre-reorg confirmations after the chain was rolled back.
function withChainLock(task) {
  const run = state.chainLock.then(task, task);
  state.chainLock = run.catch(() => undefined);
  return run;
}

function blockHashFor(blockNumber) {
  if (!state.blockHashes.has(blockNumber)) {
    state.blockHashes.set(blockNumber, syntheticHash(`block:${blockNumber}`));
  }
  return state.blockHashes.get(blockNumber);
}

function pruneBlockHashes() {
  for (const blockNumber of state.blockHashes.keys()) {
    if (blockNumber < state.blockHeight - 256) {
      state.blockHashes.delete(blockNumber);
    }
  }
}

function isChainHalted() {
  if (!state.chainHalt) {
    return false;
  }
  if (Date.parse(state.chainHalt.until) <= Date.now()) {
    state.chainHalt = null;
    return false;
  }
  return true;
}

async function advancePendingDeposits() {
  const pending = [];
  for (const network of SIMULATED_NETWORKS) {
    pending.push(
      ...normalizePaged(
        await fetchJson(
          `${config.indexerBaseUrl}/api/v1/indexer/ops/pending-deposits?${new URLSearchParams({
            network,
            limit: "100"
          })}`
        )
      ).items
    );
  }

  for (const observation of pending) {
    if (observation.blockNumber === undefined || observation.blockNumber === null) {
      continue;
    }
    // After a simulator restart the chain height is re-randomised; never let it
    // fall behind blocks we have already reported.
    state.blockHeight = Math.max(state.blockHeight, Number(observation.blockNumber));
    const confirmations = Math.max(state.blockHeight - Number(observation.blockNumber) + 1, 0);
    if (confirmations <= Number(observation.confirmations ?? 0)) {
      continue;
    }
    await fetchJson(`${config.indexerBaseUrl}/api/v1/indexer/deposits/observe`, {
      method: "POST",
      body: JSON.stringify({
        network: observation.network,
        assetCode: observation.assetCode,
        address: observation.address,
        txHash: observation.txHash,
        amount: observation.amount,
        confirmations: Math.min(confirmations, REQUIRED_CONFIRMATIONS),
        blockNumber: Number(observation.blockNumber),
        blockHash: observation.blockHash
      })
    });
  }
}

async function advanceBroadcastedWithdrawals() {
  const broadcasted = [];
  for (const network of SIMULATED_NETWORKS) {
    broadcasted.push(
      ...normalizePaged(
        await fetchJson(
          `${config.walletBaseUrl}/api/v1/wallet/withdrawals?${new URLSearchParams({
            status: "broadcasted",
            network,
            limit: "100"
          })}`
        )
      ).items
    );
  }

  for (const withdrawal of broadcasted) {
    if (!withdrawal.txHash) {
      continue;
    }
    if (!state.withdrawalBlocks.has(withdrawal.txHash)) {
      state.withdrawalBlocks.set(withdrawal.txHash, state.blockHeight);
    }
    const minedAt = state.withdrawalBlocks.get(withdrawal.txHash);
    const confirmations = Math.min(state.blockHeight - minedAt + 1, REQUIRED_CONFIRMATIONS);
    await fetchJson(`${config.indexerBaseUrl}/api/v1/indexer/withdrawals/observe`, {
      method: "POST",
      body: JSON.stringify({
        network: withdrawal.network,
        assetCode: withdrawal.assetCode,
        txHash: withdrawal.txHash,
        confirmations,
        blockNumber: minedAt,
        // Stable per block: a changing hash would look like a reorg to the indexer.
        blockHash: blockHashFor(minedAt)
      })
    });
    if (confirmations >= REQUIRED_CONFIRMATIONS) {
      state.withdrawalBlocks.delete(withdrawal.txHash);
    }
  }
}

// ---------------------------------------------------------------------------
// Market makers
// ---------------------------------------------------------------------------

// Makers are funded from the opening-balance (equity) account with ordinary
// journals, so the ledger stays reconcilable.
async function ensureMakerFunding() {
  // wallet-service credits deposits out of this treasury account; keep the
  // faucet working however often it is used.
  for (const { assetCode, floor } of buildDepositSourceFloors()) {
    await topUp(config.walletDepositSourceAccountId, assetCode, Number(floor));
  }
  // Makers quote several markets that share a quote asset, so sum the floors.
  const floors = new Map();
  const addFloor = (accountId, assetCode, amount) => {
    const key = `${accountId}:${assetCode}`;
    floors.set(key, { accountId, assetCode, amount: (floors.get(key)?.amount ?? 0) + amount });
  };
  for (const spec of MARKETS) {
    addFloor(DEMO_MAKERS.ask.accountId, spec.baseAsset, spec.baseFloor);
    addFloor(DEMO_MAKERS.ask.accountId, spec.quoteAsset, spec.quoteFloor / 4);
    addFloor(DEMO_MAKERS.bid.accountId, spec.quoteAsset, spec.quoteFloor);
    addFloor(DEMO_MAKERS.bid.accountId, spec.baseAsset, spec.baseFloor / 4);
  }
  for (const { accountId, assetCode, amount } of floors.values()) {
    await topUp(accountId, assetCode, amount);
  }
}

async function topUp(accountId, assetCode, minimumAvailable) {
  const balance = await getBalanceOrZero(config, accountId, assetCode);
  const available = Number(balance.available ?? "0");
  if (available >= minimumAvailable * 0.5) {
    return;
  }
  const amount = formatAmount(minimumAvailable - available);
  const businessId = `demo_simulator_topup:${accountId}:${assetCode}:${Date.now()}`;
  await fetchJson(`${config.ledgerBaseUrl}/api/v1/ledger/journals`, {
    method: "POST",
    body: JSON.stringify({
      businessType: "demo_simulator_topup",
      businessId,
      idempotencyKey: businessId,
      traceId: businessId,
      description: `Demo simulator top-up ${assetCode} for ${accountId}`,
      entries: [
        {
          accountId: DEMO_OPENING_BALANCE_ACCOUNT_ID,
          assetCode,
          direction: "debit",
          amount,
          referenceType: "demo_simulator_topup",
          referenceId: `${businessId}:source`
        },
        {
          accountId,
          assetCode,
          direction: "credit",
          amount,
          referenceType: "demo_simulator_topup",
          referenceId: `${businessId}:target`
        }
      ]
    })
  });
}

async function makerTick() {
  if (state.makersPaused) {
    return;
  }
  state.makerTickInFlight = runMakerTick();
  try {
    await state.makerTickInFlight;
  } finally {
    state.makerTickInFlight = null;
  }
}

async function runMakerTick() {
  state.makerTicks += 1;
  try {
    if (state.makerFundingNeeded || state.makerTicks % 20 === 1) {
      state.makerFundingNeeded = false;
      await ensureMakerFunding();
    }
    const halted = await readHaltedMarkets();
    for (const spec of MARKETS) {
      spec.halted = halted.has(spec.market);
      if (spec.halted) {
        // risk-service would reject every new order (MARKET_HALTED); leave the
        // book as it is until ops resume the market.
        continue;
      }
      await quoteMarket(spec);
    }
    state.lastMakerError = null;
  } catch (error) {
    state.lastMakerError = readErrorMessage(error);
  }
}

// Ops can halt a market at runtime (ops-console 市场管理 -> risk-service).
async function readHaltedMarkets() {
  try {
    const markets = await fetchJson(`${config.riskBaseUrl}/api/v1/risk/markets`);
    return new Set(
      (Array.isArray(markets) ? markets : [])
        .filter((item) => item.status !== "listed")
        .map((item) => item.market)
    );
  } catch {
    // risk-service down: keep quoting, orders would fail anyway.
    return new Set();
  }
}

async function quoteMarket(spec) {
  // Gaussian-ish random walk, gently pulled back towards the reference price
  // so the risk-service price-deviation guard is never hit.
  const shock = (Math.random() + Math.random() + Math.random() - 1.5) * 0.0016;
  const pull = ((spec.reference - spec.mid) / spec.reference) * 0.02;
  spec.mid = clamp(
    spec.mid * (1 + shock + pull),
    spec.reference * (1 - MAX_DRIFT_RATIO),
    spec.reference * (1 + MAX_DRIFT_RATIO)
  );

  const openOrders = (await listMakerOrders(spec.market)).filter((order) =>
    ["accepted", "partially_filled"].includes(order.status ?? "")
  );
  const asks = openOrders.filter((order) => order.side === "sell");
  const bids = openOrders.filter((order) => order.side === "buy");

  // Occasionally cross the spread so trades (and candles) are produced.
  if (Math.random() < 0.65) {
    await takeLiquidity(spec, asks, bids);
  }

  const halfSpread = spec.mid * LEVEL_SPACING_RATIO;
  const ladder = Array.from({ length: LADDER_LEVELS }, (_, index) => index);
  const askPrices = ladder.map((index) =>
    roundTo(spec.mid + halfSpread + index * spec.mid * LEVEL_SPACING_RATIO * 1.5, spec.priceDecimals)
  );
  const bidPrices = ladder.map((index) =>
    roundTo(spec.mid - halfSpread - index * spec.mid * LEVEL_SPACING_RATIO * 1.5, spec.priceDecimals)
  );

  await reconcileSide(spec, asks, askPrices, "sell", DEMO_MAKERS.ask);
  await reconcileSide(spec, bids, bidPrices, "buy", DEMO_MAKERS.bid);
}

async function reconcileSide(spec, orders, targetPrices, side, owner) {
  const lowest = Math.min(...targetPrices);
  const highest = Math.max(...targetPrices);
  const tolerance = spec.mid * LEVEL_SPACING_RATIO;
  const kept = [];

  for (const order of orders) {
    const price = Number(order.price);
    const outOfBand = price < lowest - tolerance || price > highest + tolerance;
    const wrongSide = side === "sell" ? price < spec.mid : price > spec.mid;
    if (outOfBand || wrongSide || order.accountId !== owner.accountId) {
      await cancelOrder(order, owner);
      continue;
    }
    kept.push(price);
  }

  for (const price of targetPrices) {
    const covered = kept.some((existing) => Math.abs(existing - price) < tolerance * 0.75);
    if (covered) {
      continue;
    }
    await placeOrder(spec, owner, {
      side,
      type: "limit",
      timeInForce: "gtc",
      price: price.toFixed(spec.priceDecimals),
      quantity: randomQuantity(spec)
    });
    kept.push(price);
  }
}

async function takeLiquidity(spec, asks, bids) {
  const buy = Math.random() < 0.5 + (spec.reference - spec.mid) / spec.reference;
  const book = buy ? asks : bids;
  if (book.length === 0) {
    return;
  }
  const best = buy
    ? Math.min(...book.map((order) => Number(order.price)))
    : Math.max(...book.map((order) => Number(order.price)));
  const owner = buy ? DEMO_MAKERS.bid : DEMO_MAKERS.ask;
  await placeOrder(spec, owner, {
    side: buy ? "buy" : "sell",
    type: "limit",
    timeInForce: "ioc",
    price: best.toFixed(spec.priceDecimals),
    quantity: randomQuantity(spec, 0.4)
  });
}

async function listMakerOrders(market) {
  const [asks, bids] = await Promise.all(
    [DEMO_MAKERS.ask, DEMO_MAKERS.bid].map((owner) =>
      fetchJson(
        `${config.orderBaseUrl}/api/v1/orders?${new URLSearchParams({
          market,
          accountId: owner.accountId,
          limit: "100",
          offset: "0"
        })}`
      )
    )
  );
  return [...normalizePaged(asks).items, ...normalizePaged(bids).items];
}

async function placeOrder(spec, owner, order) {
  try {
    await fetchJson(`${config.orderBaseUrl}/api/v1/orders`, {
      method: "POST",
      body: JSON.stringify({
        userId: owner.userId,
        accountId: owner.accountId,
        market: spec.market,
        idempotencyKey: `demo-simulator:${randomUUID()}`,
        ...order
      })
    });
  } catch (error) {
    // A rejected maker order (e.g. temporarily insufficient balance) is not
    // fatal; the next tick tops up if needed and re-quotes.
    state.lastMakerError = readErrorMessage(error);
    if (/INSUFFICIENT|below required/i.test(state.lastMakerError)) {
      state.makerFundingNeeded = true;
    }
  }
}

async function cancelOrder(order, owner) {
  try {
    await fetchJson(
      `${config.orderBaseUrl}/api/v1/orders/${encodeURIComponent(order.orderId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ userId: owner.userId })
      }
    );
  } catch (error) {
    state.lastMakerError = readErrorMessage(error);
  }
}

function randomQuantity(spec, scale = 1) {
  const span = spec.maxQuantity - spec.minQuantity;
  const value = (spec.minQuantity + Math.random() ** 2 * span) * scale;
  return Math.max(value, spec.minQuantity).toFixed(spec.quantityDecimals);
}

// ---------------------------------------------------------------------------
// Faucet API
// ---------------------------------------------------------------------------

async function handleFaucetDeposit(request, body) {
  const token = readBearerToken(request);
  if (!token) {
    return [401, { code: "UNAUTHORIZED", message: "Login first, then request test funds" }];
  }

  const assetCode = String(body.assetCode ?? "").toUpperCase();
  const amount = Number(body.amount);
  const limit = FAUCET_LIMITS[assetCode];
  if (!limit) {
    return [400, { code: "UNSUPPORTED_ASSET", message: `Faucet does not support ${assetCode}` }];
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > limit) {
    return [
      400,
      { code: "INVALID_AMOUNT", message: `Amount must be between 0 and ${limit} ${assetCode}` }
    ];
  }

  const gateway = (path, init = {}) =>
    fetchJson(`${config.gatewayBaseUrl}/api/v1/gateway${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    });

  // Resolve (or lazily create) the user's own deposit address via the public
  // gateway, so the faucet can only ever fund the caller.
  const addresses = normalizePaged(await gateway("/deposit-addresses?limit=50&offset=0")).items;
  const network = networkForAsset(assetCode, NETWORK);
  let address = addresses.find(
    (item) => item.assetCode === assetCode && item.network === network && item.status !== "disabled"
  );
  if (!address) {
    // The gateway provisions the spot account on first use.
    const { accountId: ledgerAccountId } = await gateway("/accounts/spot");
    address = await gateway("/deposit-addresses", {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({ ledgerAccountId, assetCode, network })
    });
  }

  const txHash = syntheticHash(`faucet:${randomUUID()}`);
  const decimals = Math.min(getAssetDefinition(assetCode)?.decimals ?? 8, 8);
  const observation = await fetchJson(`${config.indexerBaseUrl}/api/v1/indexer/deposits/observe`, {
    method: "POST",
    body: JSON.stringify({
      network,
      assetCode,
      address: address.address,
      txHash,
      amount: formatAmount(amount, decimals),
      confirmations: 1,
      blockNumber: state.blockHeight,
      blockHash: blockHashFor(state.blockHeight)
    })
  });
  state.faucetCount += 1;

  return [
    201,
    {
      txHash,
      assetCode,
      amount: formatAmount(amount, decimals),
      network,
      address: address.address,
      blockNumber: state.blockHeight,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      estimatedSeconds: Math.round((REQUIRED_CONFIRMATIONS * BLOCK_MS) / 1000),
      observationId: observation.observationId,
      observationStatus: observation.status,
      confirmations: observation.confirmations
    }
  ];
}

// Lets the UI show "confirming 5/12" before wallet-service creates the deposit
// record (wallet only learns about a deposit once the indexer forwards it).
async function handleFaucetStatus(observationId) {
  const observation = await fetchJson(
    `${config.indexerBaseUrl}/api/v1/indexer/deposits/${encodeURIComponent(observationId)}`
  );
  return [
    200,
    {
      observationId: observation.observationId,
      txHash: observation.txHash,
      assetCode: observation.assetCode,
      amount: observation.amount,
      status: observation.status,
      confirmations: observation.confirmations,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      blockNumber: observation.blockNumber,
      blockHeight: state.blockHeight
    }
  ];
}

// ---------------------------------------------------------------------------
// Fault lab: chain halt and reorg
// ---------------------------------------------------------------------------

function haltChain(body) {
  const requested = Number(body.durationSeconds) * 1000;
  const durationMs = clamp(
    Number.isFinite(requested) && requested > 0 ? requested : CHAIN_HALT_DEFAULT_MS,
    5_000,
    CHAIN_HALT_MAX_MS
  );
  state.chainHalt = {
    since: state.chainHalt?.since ?? new Date().toISOString(),
    until: new Date(Date.now() + durationMs).toISOString(),
    reason: String(body.reason ?? "fault lab"),
    requestedBy: body.requestedBy ? String(body.requestedBy) : undefined,
    haltedAtBlock: state.chainHalt?.haltedAtBlock ?? state.blockHeight
  };
  return buildLabStatus();
}

function resumeChain() {
  state.chainHalt = null;
  return buildLabStatus();
}

async function listPendingDepositObservations() {
  return normalizePaged(
    await fetchJson(
      `${config.indexerBaseUrl}/api/v1/indexer/ops/pending-deposits?${new URLSearchParams({
        network: NETWORK,
        limit: "100"
      })}`
    )
  ).items.filter(
    (observation) =>
      observation.blockNumber !== undefined &&
      observation.blockNumber !== null &&
      !["credited", "closed"].includes(observation.status) &&
      Number(observation.confirmations ?? 0) < REQUIRED_CONFIRMATIONS
  );
}

// Creates a small ETH deposit for the demo trader that is already `confirmations`
// blocks deep, so a reorg has something to roll back without anyone using the faucet.
async function seedLabDeposit(body = {}) {
  const confirmations = clamp(
    Math.trunc(Number(body.confirmations ?? Math.min(6, MAX_REORG_DEPTH))) || 1,
    1,
    MAX_REORG_DEPTH
  );
  const address = await ensureDepositAddress(config, {
    userId: DEMO_TRADER.userId,
    ledgerAccountId: DEMO_TRADER.accountId,
    assetCode: "ETH",
    network: NETWORK
  });
  const blockNumber = state.blockHeight - confirmations + 1;
  const txHash = syntheticHash(`lab-deposit:${randomUUID()}`);
  const observation = await fetchJson(`${config.indexerBaseUrl}/api/v1/indexer/deposits/observe`, {
    method: "POST",
    body: JSON.stringify({
      network: NETWORK,
      assetCode: "ETH",
      address: address.address,
      txHash,
      amount: formatAmount(Number(body.amount ?? 0.01)),
      confirmations,
      blockNumber,
      blockHash: blockHashFor(blockNumber)
    })
  });
  state.labDepositCount += 1;
  return {
    observationId: observation.observationId,
    txHash,
    address: address.address,
    userId: DEMO_TRADER.userId,
    blockNumber,
    confirmations: observation.confirmations,
    status: observation.status
  };
}

/**
 * Rolls the chain tip back `depth` blocks and mines a replacement block on the
 * new branch. Every pending deposit / broadcast withdrawal that was mined in an
 * orphaned block is re-included in the replacement block with a new block hash
 * and re-reported with 1 confirmation, exactly like a scanner that noticed the
 * reorg would. The indexer records `reorgDetectedAt` / `reorgedFromBlockNumber`
 * and confirmations restart from 1. Depth stays below the confirmation
 * threshold, so credited deposits are never affected and the ledger stays
 * reconcilable.
 */
async function triggerReorg(body = {}) {
  const depth = clamp(Math.trunc(Number(body.depth ?? 6)) || 1, 1, MAX_REORG_DEPTH);
  const seedIfEmpty = body.seedIfEmpty !== false;

  return withChainLock(async () => {
    let seeded = null;
    let candidates = await listPendingDepositObservations();
    let tip = state.blockHeight;
    let forkPoint = tip - depth;
    if (!candidates.some((observation) => Number(observation.blockNumber) > forkPoint) && seedIfEmpty) {
      seeded = await seedLabDeposit({ confirmations: depth });
      candidates = await listPendingDepositObservations();
    }
    tip = state.blockHeight;
    forkPoint = tip - depth;
    candidates = candidates.filter((observation) => Number(observation.blockNumber) > forkPoint);

    for (let blockNumber = forkPoint + 1; blockNumber <= tip; blockNumber += 1) {
      state.blockHashes.delete(blockNumber);
    }
    const replacementBlock = forkPoint + 1;
    state.blockHeight = replacementBlock;
    const replacementHash = blockHashFor(replacementBlock);

    const deposits = [];
    for (const observation of candidates) {
      const after = await fetchJson(`${config.indexerBaseUrl}/api/v1/indexer/deposits/observe`, {
        method: "POST",
        body: JSON.stringify({
          network: observation.network,
          assetCode: observation.assetCode,
          address: observation.address,
          txHash: observation.txHash,
          amount: observation.amount,
          confirmations: 1,
          blockNumber: replacementBlock,
          blockHash: replacementHash
        })
      });
      deposits.push({
        observationId: observation.observationId,
        txHash: observation.txHash,
        assetCode: observation.assetCode,
        amount: observation.amount,
        before: {
          blockNumber: Number(observation.blockNumber),
          blockHash: observation.blockHash,
          confirmations: Number(observation.confirmations ?? 0),
          status: observation.status
        },
        after: {
          blockNumber: after.blockNumber,
          blockHash: after.blockHash,
          confirmations: after.confirmations,
          status: after.status,
          reorgDetectedAt: after.reorgDetectedAt,
          reorgedFromBlockNumber: after.reorgedFromBlockNumber
        }
      });
    }

    let withdrawalsReincluded = 0;
    for (const [txHash, minedAt] of state.withdrawalBlocks) {
      if (minedAt > forkPoint) {
        state.withdrawalBlocks.set(txHash, replacementBlock);
        withdrawalsReincluded += 1;
      }
    }

    state.reorgCount += 1;
    state.lastReorg = {
      at: new Date().toISOString(),
      depth,
      previousTip: tip,
      forkPoint,
      orphanedBlocks: { from: forkPoint + 1, to: tip },
      replacementBlock,
      replacementBlockHash: replacementHash,
      seededDeposit: seeded,
      deposits,
      withdrawalsReincluded,
      requestedBy: body.requestedBy ? String(body.requestedBy) : undefined
    };
    return { reorg: state.lastReorg, ...buildLabStatus() };
  });
}

function buildLabStatus() {
  const halted = isChainHalted();
  return {
    enabled: FAULT_LAB_ENABLED,
    network: NETWORK,
    blockHeight: state.blockHeight,
    blockTimeMs: BLOCK_MS,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    maxReorgDepth: MAX_REORG_DEPTH,
    halted,
    halt: halted ? state.chainHalt : null,
    reorgCount: state.reorgCount,
    lastReorg: state.lastReorg,
    labDepositCount: state.labDepositCount,
    lastChainError: state.lastChainError
  };
}

async function handleLabRequest(request, url) {
  if (!FAULT_LAB_ENABLED) {
    return [403, { code: "FAULT_LAB_DISABLED", message: "Fault lab is disabled (DEMO_FAULT_LAB_ENABLED=false)" }];
  }
  const rawBody = await readRawBody(request);
  const verdict = verifyInternalServiceRequest({
    method: request.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    headers: request.headers,
    rawBody,
    allowedCallers: LAB_ALLOWED_CALLERS
  });
  if (!verdict.ok) {
    return [401, { code: "UNAUTHORIZED", message: verdict.reason }];
  }
  const body = parseJson(rawBody);

  if (request.method === "GET" && url.pathname === "/internal/lab/status") {
    const pendingDeposits = await listPendingDepositObservations().catch(() => []);
    return [200, { ...buildLabStatus(), pendingDeposits: pendingDeposits.slice(0, 20) }];
  }
  if (request.method === "POST" && url.pathname === "/internal/lab/chain/halt") {
    return [200, haltChain(body)];
  }
  if (request.method === "POST" && url.pathname === "/internal/lab/chain/resume") {
    return [200, resumeChain()];
  }
  if (request.method === "POST" && url.pathname === "/internal/lab/chain/seed-deposit") {
    const deposit = await withChainLock(() => seedLabDeposit(body));
    return [201, { deposit, ...buildLabStatus() }];
  }
  if (request.method === "POST" && url.pathname === "/internal/lab/chain/reorg") {
    return [200, await triggerReorg(body)];
  }
  return [404, { code: "NOT_FOUND", message: "Unknown lab route" }];
}

function buildStatus() {
  return {
    service: "demo-simulator",
    startedAt: state.startedAt,
    chain: {
      network: NETWORK,
      networks: SIMULATED_NETWORKS,
      blockHeight: state.blockHeight,
      blockTimeMs: BLOCK_MS,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      halted: isChainHalted(),
      reorgCount: state.reorgCount,
      lastError: state.lastChainError
    },
    makers: {
      enabled: MAKERS_ENABLED,
      paused: state.makersPaused,
      ticks: state.makerTicks,
      lastError: state.lastMakerError,
      markets: MARKETS.map((spec) => ({
        market: spec.market,
        mid: spec.mid.toFixed(spec.priceDecimals),
        reference: spec.reference,
        halted: Boolean(spec.halted)
      }))
    },
    faucet: {
      limits: FAUCET_LIMITS,
      requests: state.faucetCount
    }
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/api/demo/status")) {
      return writeJson(response, 200, buildStatus());
    }
    const faucetStatusMatch = /^\/api\/demo\/faucet\/([\w-]+)$/.exec(url.pathname);
    if (request.method === "GET" && faucetStatusMatch) {
      const [status, payload] = await handleFaucetStatus(faucetStatusMatch[1]);
      return writeJson(response, status, payload);
    }
    // Regression scripts pause the makers so they can trade against a fixed,
    // seeded order book. Only reachable on 127.0.0.1; trader-web does not proxy it.
    if (request.method === "POST" && url.pathname === "/api/demo/makers") {
      const body = await readJsonBody(request);
      state.makersPaused = Boolean(body.paused);
      if (!state.makersPaused) {
        // demo:reset truncates the ledger while makers are paused.
        state.makerFundingNeeded = true;
      }
      if (state.makersPaused && state.makerTickInFlight) {
        await state.makerTickInFlight.catch(() => undefined);
      }
      return writeJson(response, 200, { paused: state.makersPaused });
    }
    if (url.pathname.startsWith("/internal/lab/")) {
      const [status, payload] = await handleLabRequest(request, url);
      return writeJson(response, status, payload);
    }
    if (request.method === "POST" && url.pathname === "/api/demo/faucet") {
      const body = await readJsonBody(request);
      const [status, payload] = await handleFaucetDeposit(request, body);
      return writeJson(response, status, payload);
    }
    return writeJson(response, 404, { code: "NOT_FOUND", message: "Unknown demo route" });
  } catch (error) {
    return writeJson(response, error?.httpStatus ?? 500, {
      code: "DEMO_SIMULATOR_ERROR",
      message: readErrorMessage(error)
    });
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readBearerToken(request) {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function parseJson(rawBody) {
  if (!rawBody || rawBody.length === 0) {
    return {};
  }
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return {};
  }
}

async function readJsonBody(request) {
  return parseJson(await readRawBody(request));
}

function writeJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}

function syntheticHash(seed) {
  if (seed.startsWith("block:")) {
    // 32-byte block hash, unique per (block, branch) because of the random salt.
    return `0x${createHash("sha256").update(`${seed}:${randomBytes(8).toString("hex")}`).digest("hex")}`;
  }
  return `0x${Buffer.from(seed).toString("hex").padEnd(16, "0").slice(0, 16)}${randomBytes(24).toString("hex")}`;
}

// Fixed 8-decimal formatting avoids leaking binary floating point noise
// (e.g. 0.1 + 0.2) into ledger amounts.
function formatAmount(value, decimals = 8) {
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function schedule(task, intervalMs) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  }, intervalMs);
  return timer;
}

const timers = [schedule(chainTick, BLOCK_MS)];
if (MAKERS_ENABLED) {
  timers.push(schedule(makerTick, MAKER_INTERVAL_MS));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `demo-simulator listening on http://127.0.0.1:${PORT} (block ${BLOCK_MS}ms, makers ${MAKERS_ENABLED ? "on" : "off"})`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    timers.forEach(clearInterval);
    server.close(() => process.exit(0));
  });
}
