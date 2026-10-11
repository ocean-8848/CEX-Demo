import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { validateTradeExecutedEvent } from "../packages/domain/dist/index.js";
import { OrderApplicationService } from "../services/order-service/dist/application/order-application-service.js";
import { TcpMatchingEngineClient } from "../services/order-service/dist/infrastructure/tcp-matching-engine-client.js";
import { InMemoryOrderRepository } from "../services/order-service/dist/infrastructure/in-memory-order-repository.js";
import { SettlementApplicationService } from "../services/settlement-service/dist/application/settlement-application-service.js";
import { InMemorySettlementRepository } from "../services/settlement-service/dist/infrastructure/in-memory-settlement-repository.js";

async function main() {
  const port = await getFreePort();
  const engine = spawn("cargo", ["run", "--quiet"], {
    cwd: fileURLToPath(new URL("../engines/matching-engine", import.meta.url)),
    env: {
      ...process.env,
      MATCHING_ENGINE_HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const engineLogs = [];
  engine.stdout.on("data", (chunk) => {
    engineLogs.push(chunk.toString());
  });
  engine.stderr.on("data", (chunk) => {
    engineLogs.push(chunk.toString());
  });

  try {
    await waitForPort(port);

    const matchingEngineClient = new TcpMatchingEngineClient("127.0.0.1", port);
    const orderRepository = new InMemoryOrderRepository();
    const settlementRepository = new InMemorySettlementRepository();
    const publishedEvents = [];

    const settlementService = new SettlementApplicationService(
      settlementRepository,
      {
        async getAccount(accountId) {
          return {
            accountId,
            userId: "platform",
            accountType: accountId.includes(":fee:") ? "fee" : "spot",
            status: "active"
          };
        },
        async createAccount(command) {
          return {
            accountId: command.accountId,
            userId: command.userId,
            accountType: command.accountType,
            status: "active"
          };
        },
        async consumeBalance() {
          return {};
        },
        async postJournal(command) {
          return {
            journalId: `${command.businessType}:${command.businessId}`
          };
        }
      },
      {
        now: createClock("2026-03-10T09:00:00.000Z", 1000),
        createId: createCounter("settlement")
      }
    );

    const orderService = new OrderApplicationService(
      orderRepository,
      {
        async validateSpotOrder(command) {
          return {
            market: command.market,
            baseAsset: "BTC",
            quoteAsset: "USDT",
            lockAssetCode: command.side === "buy" ? "USDT" : "BTC",
            lockAmount: command.side === "buy" ? "1300" : command.quantity,
            feeRate: "0.001",
            timeInForce: command.timeInForce ?? "gtc"
          };
        }
      },
      {
        async freezeBalance() {
          return {};
        },
        async releaseBalance() {
          return {};
        }
      },
      {
        async settleTrade(command) {
          const settlement = await settlementService.settleTrade(command);
          return {
            settlementId: settlement.settlementId
          };
        }
      },
      matchingEngineClient,
      {
        now: createClock("2026-03-10T09:00:00.000Z", 1000),
        createId: createCounter("order"),
        eventPublisher: {
          async publish(events) {
            publishedEvents.push(...JSON.parse(JSON.stringify(events)));
          }
        }
      }
    );

    const makerOrders = [
      {
        orderId: "maker-1",
        idempotencyKey: "maker-1",
        traceId: "trace-maker-1",
        userId: "seller-1",
        accountId: "acct-seller-1",
        market: "BTC-USDT",
        side: "sell",
        type: "limit",
        timeInForce: "gtc",
        price: "65000",
        quantity: "0.01",
        filledQuantity: "0",
        restingQuantity: "0.01",
        status: "accepted",
        lockAssetCode: "BTC",
        lockAmount: "0.01",
        createdAt: "2026-03-10T08:59:00.000Z",
        updatedAt: "2026-03-10T08:59:00.000Z"
      },
      {
        orderId: "maker-2",
        idempotencyKey: "maker-2",
        traceId: "trace-maker-2",
        userId: "seller-2",
        accountId: "acct-seller-2",
        market: "BTC-USDT",
        side: "sell",
        type: "limit",
        timeInForce: "gtc",
        price: "65000",
        quantity: "0.01",
        filledQuantity: "0",
        restingQuantity: "0.01",
        status: "accepted",
        lockAssetCode: "BTC",
        lockAmount: "0.01",
        createdAt: "2026-03-10T08:59:30.000Z",
        updatedAt: "2026-03-10T08:59:30.000Z"
      }
    ];

    for (const makerOrder of makerOrders) {
      await orderRepository.saveOrder(makerOrder);
      await matchingEngineClient.seedOrder({
        orderId: makerOrder.orderId,
        market: makerOrder.market,
        side: makerOrder.side,
        price: makerOrder.price,
        quantity: makerOrder.quantity,
        createdAt: makerOrder.createdAt
      });
    }

    const takerOrder = await orderService.createOrder({
      userId: "buyer-1",
      accountId: "acct-buyer-1",
      market: "BTC-USDT",
      side: "buy",
      type: "limit",
      timeInForce: "gtc",
      price: "65000",
      quantity: "0.02",
      idempotencyKey: "buy-1"
    });

    assert.equal(takerOrder.status, "filled");

    const trades = (await orderService.listTrades({
      market: "BTC-USDT",
      limit: 10,
      offset: 0
    })).sort((left, right) => left.executionSequence - right.executionSequence);

    assert.equal(trades.length, 2);
    assert.deepEqual(
      trades.map((trade) => trade.executionSequence),
      [1, 2]
    );
    assert.deepEqual(
      trades.map((trade) => trade.replayCursor),
      ["BTC-USDT:1", "BTC-USDT:2"]
    );

    const tradeEvents = publishedEvents.filter((event) => event.eventType === "trade.executed");
    assert.equal(tradeEvents.length, 2);
    for (const event of tradeEvents) {
      validateTradeExecutedEvent(event);
    }

    const firstReplay = await settlementService.replayTradeExecutionEvents({
      consumerId: "trade-settlement",
      events: tradeEvents
    });
    const secondReplay = await settlementService.replayTradeExecutionEvents({
      consumerId: "trade-settlement",
      events: tradeEvents
    });
    const checkpoints = await settlementService.listTradeEventConsumerCheckpoints({
      consumerId: "trade-settlement",
      market: "BTC-USDT"
    });
    const settlements = await settlementService.listSettlements({
      market: "BTC-USDT",
      limit: 10,
      offset: 0
    });

    assert.equal(settlements.length, 2);
    assert.equal(firstReplay.appliedCount, 2);
    assert.equal(secondReplay.duplicateCount, 2);
    assert.equal(checkpoints[0]?.lastExecutionSequence, 2);
    assert.equal(checkpoints[0]?.lastReplayCursor, "BTC-USDT:2");

    console.log(
      JSON.stringify(
        {
          status: "ok",
          market: "BTC-USDT",
          tradeCount: trades.length,
          latestExecutionSequence: checkpoints[0]?.lastExecutionSequence,
          latestReplayCursor: checkpoints[0]?.lastReplayCursor,
          duplicateReplayCount: secondReplay.duplicateCount
        },
        null,
        2
      )
    );
  } finally {
    engine.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => engine.once("exit", resolve)),
      delay(5000)
    ]);
  }
}

function createClock(startAt, stepMs) {
  let cursor = Date.parse(startAt);
  return () => {
    const current = new Date(cursor);
    cursor += stepMs;
    return current;
  };
}

function createCounter(prefix) {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({
        host: "127.0.0.1",
        port
      });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await delay(250);
  }

  throw new Error(`matching-engine did not start on port ${port.toString()}`);
}

await main();
