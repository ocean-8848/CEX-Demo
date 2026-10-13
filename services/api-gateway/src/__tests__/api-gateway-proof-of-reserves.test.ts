import assert from "node:assert/strict";
import test from "node:test";

import { ApiGatewayApplicationService } from "../application/api-gateway-application-service.js";
import type {
  GatewayPrincipal,
  IdentityGatewayClient,
  LedgerGatewayClient,
  OrderGatewayClient,
  WalletGatewayClient
} from "../domain/types.js";
import { InMemoryRateLimiter } from "../infrastructure/in-memory-rate-limiter.js";

const principal: GatewayPrincipal = {
  authType: "session",
  userId: "user-1",
  status: "active",
  userType: "customer",
  roles: [],
  permissions: [],
  createdAt: "2026-03-07T00:00:00.000Z",
  active: true
};

function createService(walletClient: Partial<WalletGatewayClient>) {
  return new ApiGatewayApplicationService(
    {} as IdentityGatewayClient,
    walletClient as WalletGatewayClient,
    {} as LedgerGatewayClient,
    {} as OrderGatewayClient,
    new InMemoryRateLimiter()
  );
}

test("proof of reserves is always read for the authenticated user", async () => {
  const calls: string[] = [];
  const service = createService({
    async getProofOfReserves(userId) {
      calls.push(userId);
      return { available: true, included: true };
    }
  });
  assert.deepEqual(await service.getProofOfReserves(principal), { available: true, included: true });
  assert.deepEqual(calls, ["user-1"]);
});

test("proof of reserves reports 503 when the wallet client cannot serve it", async () => {
  await assert.rejects(createService({}).getProofOfReserves(principal), /not available/);
});
