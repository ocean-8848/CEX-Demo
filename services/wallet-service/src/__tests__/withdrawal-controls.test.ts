import assert from "node:assert/strict";
import test from "node:test";

import {
  buildControlSwitchState,
  type ControlSwitchEntry,
  type ControlSwitchState
} from "@web3-cex/domain";

import { WalletApplicationService } from "../application/wallet-application-service.js";
import type { CustodyClient } from "../domain/custody-client.js";
import type { IdentityClient } from "../domain/identity-client.js";
import type { LedgerClient } from "../domain/ledger-client.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";

const ADDRESS = "0x7777777777777777777777777777777777777777";

function switchEntry(partial: Partial<ControlSwitchEntry> & Pick<ControlSwitchEntry, "scope">): ControlSwitchEntry {
  return { reason: "drill", source: "manual", updatedBy: "ops", updatedAt: "2026-01-01T00:00:00.000Z", ...partial };
}

function createHarness() {
  let state: ControlSwitchState = buildControlSwitchState([]);
  let idCounter = 0;
  const freezes: string[] = [];
  const verifiedCodes: string[] = [];
  const custodyCalls: string[] = [];
  const ledgerClient: LedgerClient = {
    async postDepositCredit() {
      throw new Error("unexpected");
    },
    async freezeBalance(command) {
      freezes.push(command.referenceId);
      return { lockId: "lock" };
    },
    async releaseBalance() {
      return { lockId: "lock" };
    },
    async consumeBalance() {
      return { lockId: "lock" };
    }
  };
  const custodyClient: CustodyClient = {
    async createTransfer(command) {
      custodyCalls.push(command.withdrawalId);
      return { providerName: "mock-custody", custodyRequestId: `c-${command.withdrawalId}`, txHash: `0x${"b".repeat(63)}${custodyCalls.length}` };
    }
  };
  const identityClient: IdentityClient = {
    async getTwoFactorStatus(userId) {
      return { userId, enabled: true, pendingEnrollment: false };
    },
    async verifyTwoFactor(command) {
      verifiedCodes.push(command.code);
      return { verifiedAt: new Date().toISOString(), purpose: command.purpose };
    },
    async getKycProfile(userId) {
      return { userId, tier: "L2" };
    }
  };
  const service = new WalletApplicationService(
    new InMemoryWalletRepository(),
    ledgerClient,
    custodyClient,
    {
      createId: () => `withdrawal-${++idCounter}`,
      controlSwitches: { getState: async () => state }
    },
    identityClient
  );
  return {
    service,
    freezes,
    verifiedCodes,
    custodyCalls,
    setSwitches(entries: ControlSwitchEntry[]) {
      state = buildControlSwitchState(entries);
    }
  };
}

const request = (assetCode: "USDT" | "ETH", amount: string) => ({
  userId: "user-ctl",
  ledgerAccountId: "ledger-ctl",
  assetCode,
  network: "ethereum" as const,
  toAddress: ADDRESS,
  amount,
  fee: assetCode === "USDT" ? "1" : "0.001",
  twoFactorCode: "123456"
});

const codeOf = (error: unknown) => (error as { code?: string }).code;

test("asset pause rejects the request before freezing funds or using the 2FA code", async () => {
  const harness = createHarness();
  harness.setSwitches([switchEntry({ scope: "withdrawals_asset", assetCode: "USDT" })]);
  await assert.rejects(() => harness.service.requestWithdrawal(request("USDT", "10")), (error) => codeOf(error) === "ASSET_WITHDRAWALS_PAUSED");
  await assert.rejects(() => harness.service.validateWithdrawalRequest(request("USDT", "10")), (error) => codeOf(error) === "ASSET_WITHDRAWALS_PAUSED");
  assert.deepEqual(harness.freezes, []);
  assert.deepEqual(harness.verifiedCodes, [], "the one-time code is not consumed");
  const eth = await harness.service.requestWithdrawal(request("ETH", "0.1"));
  assert.equal(eth.status, "requested", "other assets keep working");
});

test("a pause also blocks approval / broadcast of queued withdrawals; reject still works", async () => {
  const harness = createHarness();
  const queued = await harness.service.requestWithdrawal(request("USDT", "10"));
  const another = await harness.service.requestWithdrawal(request("USDT", "11"));
  harness.setSwitches([switchEntry({ scope: "withdrawals_global", reason: "incident" })]);
  await assert.rejects(
    () => harness.service.approveWithdrawal({ withdrawalId: queued.withdrawalId, reviewedBy: "ops-a" }),
    (error) => codeOf(error) === "WITHDRAWALS_PAUSED"
  );
  assert.deepEqual(harness.custodyCalls, [], "nothing is broadcast while paused");
  const rejected = await harness.service.rejectWithdrawal({ withdrawalId: another.withdrawalId, reviewedBy: "ops-a", reason: "paused" });
  assert.equal(rejected.reviewStatus, "rejected");

  harness.setSwitches([]);
  const approved = await harness.service.approveWithdrawal({ withdrawalId: queued.withdrawalId, reviewedBy: "ops-a" });
  assert.equal(approved.status, "broadcasted");
});

test("API write freeze blocks new requests but not ops approval", async () => {
  const harness = createHarness();
  const queued = await harness.service.requestWithdrawal(request("USDT", "10"));
  harness.setSwitches([switchEntry({ scope: "api_write" })]);
  await assert.rejects(() => harness.service.requestWithdrawal(request("USDT", "10")), (error) => codeOf(error) === "API_WRITE_FROZEN");
  const approved = await harness.service.approveWithdrawal({ withdrawalId: queued.withdrawalId, reviewedBy: "ops-a" });
  assert.equal(approved.status, "broadcasted");
});
