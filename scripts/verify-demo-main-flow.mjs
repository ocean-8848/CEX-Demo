import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  bootstrapStandardDemo,
  DEMO_MARKET,
  DEMO_OPS,
  DEMO_PRICE_REFERENCE,
  DEMO_TRADER,
  DEMO_WITHDRAWAL_ADDRESS,
  fetchJson,
  generateTotpCode,
  loadDemoConfig,
  normalizePaged,
  resetDemoState,
  setDemoMakersPaused,
  waitForCondition
} from "./mvp-demo-lib.mjs";

const DEPOSIT_AMOUNT = process.env.DEMO_VERIFY_FLOW_DEPOSIT_AMOUNT ?? "37.5";
const ORDER_QUANTITY = process.env.DEMO_VERIFY_FLOW_ORDER_QUANTITY ?? "0.05";
const ORDER_PRICE = process.env.DEMO_VERIFY_FLOW_ORDER_PRICE ?? DEMO_PRICE_REFERENCE;
const WITHDRAWAL_AMOUNT = process.env.DEMO_VERIFY_FLOW_WITHDRAWAL_AMOUNT ?? "12.5";
const WITHDRAWAL_FEE = process.env.DEMO_VERIFY_FLOW_WITHDRAWAL_FEE ?? "0.1";
const CONFIRMATIONS = Number(process.env.DEMO_VERIFY_FLOW_CONFIRMATIONS ?? "12");
const WAIT_TIMEOUT_MS = Number(process.env.DEMO_VERIFY_FLOW_TIMEOUT_MS ?? "45000");
const AUTO_RESET = process.env.DEMO_VERIFY_FLOW_RESET !== "false";

const flowConfig = loadDemoConfig(process.env);
// The flow trades against the fixed seeded book, so live simulator makers are paused.
await setDemoMakersPaused(flowConfig, true);
try {
  const result = await verifyDemoMainFlow(flowConfig);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await setDemoMakersPaused(flowConfig, false);
}

export async function verifyDemoMainFlow(config) {
  const reset = AUTO_RESET ? await resetDemoState(config) : null;
  await bootstrapStandardDemo(config);

  const traderSession = await createTraderSession(config);
  const traderBalancesBefore = await listGatewayBalances(config, traderSession.token);
  const traderUsdtBefore = readBalanceAmount(traderBalancesBefore, DEMO_TRADER.accountId, "USDT");

  const depositAddress = await findDepositAddress(config, traderSession.token, "USDT", config.demoNetwork);
  assert.ok(depositAddress?.address, "Demo trader deposit address is missing");

  const depositTxHash = buildDeterministicTxHash("deposit");
  const depositObservation = await fetchJson(
    `${config.indexerBaseUrl ?? resolveIndexerBaseUrl(config)}/api/v1/indexer/deposits/observe`,
    {
      method: "POST",
      body: JSON.stringify({
        network: config.demoNetwork,
        assetCode: "USDT",
        address: depositAddress.address,
        txHash: depositTxHash,
        amount: DEPOSIT_AMOUNT,
        confirmations: CONFIRMATIONS,
        blockNumber: randomBlockNumber(),
        blockHash: buildDeterministicTxHash("deposit-block")
      })
    }
  );

  const creditedDeposit = await waitForCondition(
    "credited deposit on gateway",
    async () => {
      const deposits = normalizePaged(
        await fetchJson(
          `${config.gatewayBaseUrl}/api/v1/gateway/deposits?${new URLSearchParams({
            txHash: depositTxHash,
            limit: "5",
            offset: "0"
          }).toString()}`,
          {
            headers: {
              authorization: `Bearer ${traderSession.token}`
            }
          }
        )
      ).items;
      const matched = deposits.find((item) => item.txHash === depositTxHash);
      return matched?.status === "credited" ? matched : null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const traderBalancesAfterDeposit = await waitForCondition(
    "credited balance update",
    async () => {
      const balances = await listGatewayBalances(config, traderSession.token);
      const usdtBalance = readBalanceAmount(balances, DEMO_TRADER.accountId, "USDT");
      return usdtBalance >= traderUsdtBefore + Number(DEPOSIT_AMOUNT)
        ? {
            balances,
            usdtBalance
          }
        : null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const orderIdempotencyKey = `demo-main-flow-order:${randomUUID()}`;
  const order = await fetchJson(`${config.gatewayBaseUrl}/api/v1/gateway/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${traderSession.token}`,
      "idempotency-key": orderIdempotencyKey
    },
    body: JSON.stringify({
      accountId: DEMO_TRADER.accountId,
      market: config.demoMarket,
      side: "buy",
      type: "limit",
      timeInForce: "ioc",
      price: ORDER_PRICE,
      quantity: ORDER_QUANTITY,
      idempotencyKey: orderIdempotencyKey
    })
  });

  const matchedOrder = await waitForCondition(
    "matched order",
    async () => {
      const payload = await fetchJson(
        `${config.gatewayBaseUrl}/api/v1/gateway/orders/${encodeURIComponent(order.orderId)}`,
        {
          headers: {
            authorization: `Bearer ${traderSession.token}`
          }
        }
      );
      return isFullyMatchedOrder(payload) ? payload : null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const trade = await waitForCondition(
    "trade execution",
    async () => {
      const trades = await fetchJson(
        `${config.gatewayBaseUrl}/api/v1/gateway/trades?${new URLSearchParams({
          market: config.demoMarket,
          orderId: order.orderId,
          limit: "5",
          offset: "0"
        }).toString()}`,
        {
          headers: {
            authorization: `Bearer ${traderSession.token}`
          }
        }
      );
      return Array.isArray(trades) && trades.length > 0 ? trades[0] : null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const settlementProcess = await kickSettlementProcess(config);

  const settlement = await waitForCondition(
    "settlement result",
    async () => {
      const settlements = normalizePaged(
        await fetchJson(
          `${config.settlementBaseUrl}/api/v1/settlement/trades?${new URLSearchParams({
            userId: DEMO_TRADER.userId,
            orderId: order.orderId,
            market: config.demoMarket,
            limit: "5",
            offset: "0"
          }).toString()}`
        )
      ).items;
      const matched = settlements.find((item) => item.tradeId === trade.tradeId || item.orderId === order.orderId);
      if (matched?.status === "settled") {
        return matched;
      }
      await kickSettlementProcess(config);
      return null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const withdrawalValidation = await fetchJson(
    `${config.gatewayBaseUrl}/api/v1/gateway/withdrawals/validate`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${traderSession.token}`
      },
      body: JSON.stringify({
        ledgerAccountId: DEMO_TRADER.accountId,
        assetCode: "USDT",
        network: config.demoNetwork,
        toAddress: config.withdrawalAddress ?? DEMO_WITHDRAWAL_ADDRESS,
        amount: WITHDRAWAL_AMOUNT,
        fee: WITHDRAWAL_FEE
      })
    }
  );

  const withdrawalRequest = await fetchJson(
    `${config.gatewayBaseUrl}/api/v1/gateway/withdrawals/request`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${traderSession.token}`,
        "idempotency-key": `demo-main-flow-withdrawal:${randomUUID()}`
      },
      body: JSON.stringify({
        ledgerAccountId: DEMO_TRADER.accountId,
        assetCode: "USDT",
        network: config.demoNetwork,
        toAddress: config.withdrawalAddress ?? DEMO_WITHDRAWAL_ADDRESS,
        amount: WITHDRAWAL_AMOUNT,
        fee: WITHDRAWAL_FEE
      })
    }
  );

  const opsSession = await createOpsSession(config);

  const reviewQueueEntry = await waitForCondition(
    "withdrawal in ops review queue",
    async () => {
      const queue = normalizePaged(
        await fetchJson(
          `${config.opsConsoleBaseUrl}/api/v1/ops/withdrawals/review-queue?${new URLSearchParams({
            network: config.demoNetwork,
            assetCode: "USDT",
            limit: "20",
            offset: "0"
          }).toString()}`,
          {
            headers: {
              authorization: `Bearer ${opsSession.token}`
            }
          }
        )
      ).items;
      return queue.find((item) => item.withdrawalId === withdrawalRequest.withdrawalId) ?? null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const approvedWithdrawal = await fetchJson(
    `${config.opsConsoleBaseUrl}/api/v1/ops/withdrawals/${encodeURIComponent(
      withdrawalRequest.withdrawalId
    )}/approve`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${opsSession.token}`
      },
      body: JSON.stringify({
        note: "demo main flow verification"
      })
    }
  );

  const broadcastedWithdrawal = await waitForCondition(
    "broadcasted withdrawal",
    async () => {
      const payload = await fetchJson(
        `${config.gatewayBaseUrl}/api/v1/gateway/withdrawals/${encodeURIComponent(
          withdrawalRequest.withdrawalId
        )}`,
        {
          headers: {
            authorization: `Bearer ${traderSession.token}`
          }
        }
      );
      return payload?.status === "broadcasted" || payload?.status === "confirmed" ? payload : null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  assert.ok(
    typeof broadcastedWithdrawal.txHash === "string" && broadcastedWithdrawal.txHash.length > 0,
    "Approved withdrawal is missing txHash"
  );

  const withdrawalObservation = await fetchJson(
    `${config.indexerBaseUrl ?? resolveIndexerBaseUrl(config)}/api/v1/indexer/withdrawals/observe`,
    {
      method: "POST",
      body: JSON.stringify({
        network: config.demoNetwork,
        assetCode: "USDT",
        txHash: broadcastedWithdrawal.txHash,
        confirmations: CONFIRMATIONS,
        blockNumber: randomBlockNumber(),
        blockHash: buildDeterministicTxHash("withdrawal-block")
      })
    }
  );

  const confirmedWithdrawal = await waitForCondition(
    "confirmed withdrawal",
    async () => {
      const payload = await fetchJson(
        `${config.gatewayBaseUrl}/api/v1/gateway/withdrawals/${encodeURIComponent(
          withdrawalRequest.withdrawalId
        )}`,
        {
          headers: {
            authorization: `Bearer ${traderSession.token}`
          }
        }
      );
      return payload?.status === "confirmed" ? payload : null;
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 1_000 }
  );

  const notifications = normalizePaged(
    await fetchJson(
      `${config.gatewayBaseUrl}/api/v1/gateway/notifications?${new URLSearchParams({
        withdrawalId: withdrawalRequest.withdrawalId,
        limit: "20",
        offset: "0"
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${traderSession.token}`
        }
      }
    )
  ).items;

  const expectedNotificationTypes = [
    "withdrawal.requested",
    "withdrawal.approved",
    "withdrawal.broadcasted",
    "withdrawal.confirmed"
  ];

  for (const eventType of expectedNotificationTypes) {
    assert.ok(
      notifications.some((item) => item.eventType === eventType),
      `Expected wallet notification ${eventType}`
    );
  }

  return {
    status: "ok",
    market: config.demoMarket ?? DEMO_MARKET,
    reset,
    trader: {
      userId: DEMO_TRADER.userId,
      accountId: DEMO_TRADER.accountId
    },
    deposit: {
      txHash: depositTxHash,
      address: depositAddress.address,
      amount: DEPOSIT_AMOUNT,
      observationStatus: depositObservation.status,
      creditedDepositId: creditedDeposit.depositId,
      creditedStatus: creditedDeposit.status,
      usdtAvailableBefore: traderUsdtBefore.toFixed(8),
      usdtAvailableAfter: traderBalancesAfterDeposit.usdtBalance.toFixed(8)
    },
    trade: {
      orderId: order.orderId,
      orderStatus: matchedOrder.status,
      price: trade.price,
      quantity: trade.quantity,
      tradeId: trade.tradeId
    },
    settlement: {
      process: settlementProcess,
      settlementId: settlement.settlementId,
      status: settlement.status,
      quoteAmount: settlement.quoteAmount,
      feeAmount: settlement.feeAmount
    },
    withdrawal: {
      validationStatus: withdrawalValidation.status,
      withdrawalId: withdrawalRequest.withdrawalId,
      reviewQueueStatus: reviewQueueEntry.reviewStatus ?? reviewQueueEntry.status,
      approveStatus: approvedWithdrawal.status ?? approvedWithdrawal.reviewStatus,
      txHash: broadcastedWithdrawal.txHash,
      observationStatus: withdrawalObservation.status,
      finalStatus: confirmedWithdrawal.status,
      reviewStatus: confirmedWithdrawal.reviewStatus
    },
    notifications: notifications
      .filter((item) => expectedNotificationTypes.includes(item.eventType))
      .map((item) => ({
        eventType: item.eventType,
        status: item.status
      }))
  };
}

async function createTraderSession(config) {
  const session = await fetchJson(`${config.gatewayBaseUrl}/api/v1/gateway/auth/sessions`, {
    method: "POST",
    body: JSON.stringify({
      email: DEMO_TRADER.email,
      password: DEMO_TRADER.password
    })
  });
  assert.ok(typeof session.token === "string" && session.token.length > 0, "Trader session token missing");
  return session;
}

async function createOpsSession(config) {
  const session = await fetchJson(`${config.opsConsoleBaseUrl}/api/v1/ops/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      email: DEMO_OPS.email,
      password: DEMO_OPS.password,
      twoFactorCode: generateTotpCode(DEMO_OPS.twoFactorSecret, new Date()).code
    })
  });
  assert.ok(typeof session.token === "string" && session.token.length > 0, "Ops session token missing");
  return session;
}

async function listGatewayBalances(config, token) {
  const balances = await fetchJson(
    `${config.gatewayBaseUrl}/api/v1/gateway/balances?${new URLSearchParams({
      accountId: DEMO_TRADER.accountId,
      limit: "50",
      offset: "0"
    }).toString()}`,
    {
      headers: {
        authorization: `Bearer ${token}`
      }
    }
  );
  return normalizePaged(balances).items;
}

function readBalanceAmount(balances, accountId, assetCode) {
  const item = balances.find(
    (balance) => balance.accountId === accountId && balance.assetCode === assetCode
  );
  return Number(item?.available ?? "0");
}

async function findDepositAddress(config, token, assetCode, network) {
  const payload = normalizePaged(
    await fetchJson(
      `${config.gatewayBaseUrl}/api/v1/gateway/deposit-addresses?${new URLSearchParams({
        ledgerAccountId: DEMO_TRADER.accountId,
        assetCode,
        network,
        limit: "20",
        offset: "0"
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${token}`
        }
      }
    )
  ).items;
  return payload.find(
    (item) =>
      item.assetCode === assetCode &&
      item.network === network &&
      item.ledgerAccountId === DEMO_TRADER.accountId
  );
}

function buildDeterministicTxHash(prefix) {
  const seed = `${prefix}:${randomUUID().replaceAll("-", "")}`;
  return `0x${seed.replace(/[^a-fA-F0-9]/g, "a").slice(0, 64).padEnd(64, "0")}`;
}

function randomBlockNumber() {
  return 10_000_000 + Math.floor(Math.random() * 100_000);
}

function resolveIndexerBaseUrl(config) {
  return config.indexerBaseUrl ?? process.env.DEMO_INDEXER_URL ?? "http://127.0.0.1:3003";
}

function isFullyMatchedOrder(order) {
  const requestedQuantity = Number(order?.quantity ?? "0");
  const filledQuantity = Number(order?.filledQuantity ?? "0");
  if (!Number.isFinite(requestedQuantity) || !Number.isFinite(filledQuantity)) {
    return false;
  }
  if (requestedQuantity === 0) {
    return false;
  }
  return filledQuantity >= requestedQuantity - 1e-12;
}

async function kickSettlementProcess(config) {
  try {
    return await fetchJson(`${config.settlementBaseUrl}/api/v1/settlement/event-bus/process`, {
      method: "POST",
      body: JSON.stringify({
        market: config.demoMarket,
        limit: 20,
        overlapCount: 5
      })
    });
  } catch (error) {
    if (error?.httpStatus === 409) {
      return {
        status: "already_running"
      };
    }
    throw error;
  }
}
