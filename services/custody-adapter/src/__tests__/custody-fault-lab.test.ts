import test from "node:test";
import assert from "node:assert/strict";

import { CustodyApplicationService } from "../application/custody-application-service.js";
import { CustodyFaultLab } from "../application/custody-fault-lab.js";
import { CustodyProviderHealthWorker } from "../application/custody-provider-health-worker.js";
import { createCustodyProviderStack } from "../infrastructure/custody-runtime-factory.js";
import { InMemoryCustodyRepository } from "../infrastructure/in-memory-custody-repository.js";

function createLab(env: NodeJS.ProcessEnv = {}) {
  let now = new Date("2026-10-10T10:00:00.000Z");
  const clock = () => now;
  const stack = createCustodyProviderStack(
    { CUSTODY_PROVIDER_FAILURE_THRESHOLD: "2", ...env },
    { now: clock }
  );
  const healthWorker = new CustodyProviderHealthWorker(stack.providerResolver, stack.runtimeRegistry, {
    now: clock
  });
  const lab = new CustodyFaultLab(
    stack.faultInjector,
    stack.providerResolver,
    stack.runtimeRegistry,
    healthWorker,
    { now: clock }
  );
  return {
    ...stack,
    lab,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    clock
  };
}

test("injected broadcast failures open the circuit and fail over to the backup provider", async () => {
  const { lab, providerResolver, runtimeRegistry, clock } = createLab();

  const injected = lab.inject({ providerName: "mock-custody", durationMs: 60_000, requestedBy: "ops" });
  assert.equal(injected.injection.providerName, "mock-custody");
  assert.equal(injected.injection.expiresAt, "2026-10-10T10:01:00.000Z");

  const probe = await lab.probeBroadcast({ network: "ethereum", count: 3 });
  assert.deepEqual(
    probe.attempts.map((attempt) => `${attempt.providerName}:${attempt.outcome}`),
    ["mock-custody:failed", "mock-custody:failed", "mock-custody-backup:succeeded"]
  );
  assert.equal(probe.attempts[0]?.circuitStateAfter, "closed");
  assert.equal(probe.attempts[1]?.circuitStateAfter, "open");
  assert.equal(probe.attempts[1]?.errorCode, "PROVIDER_BROADCAST_FAILED");

  // Real withdrawals take the same route while the circuit is open.
  const service = new CustodyApplicationService(new InMemoryCustodyRepository(), providerResolver, {
    now: clock,
    runtimeRegistry
  });
  const transfer = await service.createTransfer({
    referenceId: "wd-1",
    assetCode: "ETH",
    network: "ethereum",
    toAddress: "0x1234567890abcdef1234567890abcdef12345678",
    amount: "0.1",
    fee: "0",
    idempotencyKey: "wd-1"
  });
  assert.equal(transfer.providerName, "mock-custody-backup");
  assert.equal(transfer.status, "broadcasted");
});

test("clearing the fault runs a health check that closes the circuit and restores the primary route", async () => {
  const { lab } = createLab();
  lab.inject({ providerName: "mock-custody" });
  await lab.probeBroadcast({ network: "ethereum", count: 2 });

  const cleared = await lab.clear();
  assert.deepEqual(cleared.cleared, ["mock-custody"]);
  assert.equal(cleared.injections.length, 0);
  const primary = cleared.routes.find(
    (route) => route.providerName === "mock-custody" && route.network === "ethereum"
  );
  assert.equal(primary?.circuitState, "closed");
  assert.equal(primary?.healthStatus, "healthy");

  const probe = await lab.probeBroadcast({ network: "ethereum", count: 1 });
  assert.equal(probe.attempts[0]?.providerName, "mock-custody");
  assert.equal(probe.attempts[0]?.outcome, "succeeded");
});

test("an injected provider reports itself unhealthy and the fault expires on its own", async () => {
  const { lab, faultInjector, advance } = createLab();
  lab.inject({ providerName: "mock-custody", durationMs: 30_000 });

  const health = await lab.clear("mock-custody-backup");
  assert.deepEqual(health.cleared, []);
  const unhealthy = health.routes.find(
    (route) => route.providerName === "mock-custody" && route.network === "ethereum"
  );
  assert.equal(unhealthy?.healthStatus, "unhealthy");
  assert.equal(unhealthy?.lastErrorCode, "FAULT_INJECTED");

  advance(30_001);
  assert.equal(faultInjector.getActiveInjection("mock-custody"), undefined);
  assert.equal(lab.getState().injections.length, 0);
});

test("only mock providers can be injected and the lab can be switched off", () => {
  const { lab } = createLab();
  assert.throws(
    () => lab.inject({ providerName: "evm-hot-wallet" }),
    (error: Error & { code?: string }) => error.code === "FAULT_LAB_INVALID_TARGET"
  );

  const disabled = createLab({ CUSTODY_FAULT_LAB_ENABLED: "false" });
  assert.throws(
    () => disabled.lab.inject({}),
    (error: Error & { code?: string }) => error.code === "FAULT_LAB_DISABLED"
  );
});

test("probes never reach a real provider", async () => {
  const { lab } = createLab({ CUSTODY_PROVIDER_ORDER: "evm-hot-wallet,mock-custody" });
  const probe = await lab.probeBroadcast({ network: "ethereum", count: 3 });
  // evm-hot-wallet has no RPC configured in tests, so it is either skipped as
  // unsupported (routing falls to mock-custody) or reported as a real provider.
  assert.ok(probe.attempts.length > 0);
  assert.ok(
    probe.attempts.every(
      (attempt) =>
        attempt.providerName !== "evm-hot-wallet" || attempt.outcome === "skipped_real_provider"
    )
  );
});
