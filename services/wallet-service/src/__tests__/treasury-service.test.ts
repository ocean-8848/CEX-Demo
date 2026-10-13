import assert from "node:assert/strict";
import test from "node:test";

import { TreasuryService, sha256Hex } from "../application/treasury-service.js";
import { verifyMerkleProof } from "../domain/proof-of-reserves.js";
import type { TreasuryCustodyClient, TreasuryLedgerClient } from "../domain/treasury-clients.js";
import { TreasuryError } from "../domain/treasury-errors.js";
import { parseHotWalletWatermarks } from "../domain/treasury-policy.js";
import type { TreasuryConfig } from "../domain/treasury-types.js";
import type { DepositRecord } from "../domain/types.js";
import { InMemoryTreasuryRepository } from "../infrastructure/in-memory-treasury-repository.js";
import { InMemoryWalletRepository } from "../infrastructure/in-memory-wallet-repository.js";

const config: TreasuryConfig = {
  watermarks: parseHotWalletWatermarks("USDT=1000/5000,ETH=1/4"),
  sweepMinAmounts: {},
  confirmationThreshold: 12,
  sweepBatchSize: 100,
  hotWalletAddress: () => "0xhot",
  coldWalletAddress: () => "0xcold"
};

function deposit(overrides: Partial<DepositRecord>): DepositRecord {
  return {
    depositId: overrides.depositId ?? `dep-${Math.random()}`,
    userId: "user-1",
    ledgerAccountId: "acct-1",
    assetCode: "USDT",
    network: "ethereum",
    address: "0xuser1",
    txHash: `0x${Math.random().toString(16).slice(2)}`,
    amount: "100",
    confirmations: 12,
    status: "credited",
    detectedAt: "2026-01-01T00:00:00.000Z",
    creditedAt: "2026-01-01T00:00:01.000Z",
    metadata: {},
    ...overrides
  };
}

function setup(options: { failBroadcast?: () => boolean; liabilities?: Array<{ userId: string; balances: Record<string, string> }> } = {}) {
  const walletRepository = new InMemoryWalletRepository();
  const repository = new InMemoryTreasuryRepository(walletRepository);
  const broadcasts: Array<Record<string, unknown>> = [];
  let tx = 0;
  const custody: TreasuryCustodyClient = {
    async broadcastInternalTransfer(command) {
      broadcasts.push(command);
      if (options.failBroadcast?.()) {
        throw new Error("provider down");
      }
      tx += 1;
      return { custodyTransferId: `ct-${tx}`, providerName: "mock-custody", txHash: `0xtx${tx}`, status: "broadcasted" };
    }
  };
  const users = options.liabilities ?? [];
  const ledger: TreasuryLedgerClient = {
    async getLiabilitySummary() {
      const totals = new Map<string, number>();
      for (const user of users) {
        for (const [asset, amount] of Object.entries(user.balances)) {
          totals.set(asset, (totals.get(asset) ?? 0) + Number(amount));
        }
      }
      return {
        generatedAt: "2026-01-01T00:00:00.000Z",
        userCount: users.length,
        assets: [...totals].map(([assetCode, value]) => ({
          assetCode,
          total: String(value),
          available: String(value),
          locked: "0",
          userCount: 1
        }))
      };
    },
    async listUserLiabilities() {
      return { generatedAt: "2026-01-01T00:00:00.000Z", items: users };
    }
  };
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  let id = 0;
  let nonce = 0;
  const service = new TreasuryService(repository, custody, ledger, config, {
    now: () => new Date((clock += 1000)),
    createId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    createNonce: () => `nonce-${(nonce += 1)}`
  });
  return { service, walletRepository, repository, broadcasts };
}

const usdtOf = async (service: TreasuryService) =>
  (await service.getHoldings()).find((item) => item.assetCode === "USDT")!;

test("sweep moves credited deposits to the hot wallet once the chain confirms it", async () => {
  const { service, walletRepository, broadcasts } = setup();
  await walletRepository.saveDeposit(deposit({ depositId: "d1", amount: "100" }));
  await walletRepository.saveDeposit(deposit({ depositId: "d2", amount: "50" }));
  await walletRepository.saveDeposit(deposit({ depositId: "d3", amount: "1", address: "0xuser2", userId: "user-2" }));
  await walletRepository.saveDeposit(deposit({ depositId: "d4", amount: "9", status: "confirming" }));

  assert.equal((await usdtOf(service)).depositAddresses, "151");

  const run = await service.runSweeps({ requestedBy: "ops@example.com" });
  assert.equal(run.plannedCount, 2, "one sweep per deposit address");
  assert.equal(run.broadcastedCount, 2);
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0]?.toAddress, "0xhot");

  let usdt = await usdtOf(service);
  assert.equal(usdt.depositAddresses, "0");
  assert.equal(usdt.internalInTransit, "151");
  assert.equal(usdt.hot, "0");
  assert.equal(usdt.total, "151");

  const again = await service.runSweeps();
  assert.equal(again.plannedCount, 0, "swept deposits are not swept twice");

  const sweep = run.transfers.find((item) => item.fromAddress === "0xuser1")!;
  assert.deepEqual((await service.getTransfer(sweep.transferId)).sweptDepositIds, ["d1", "d2"]);
  const partial = await service.confirmTransfer({ network: "ethereum", txHash: sweep.txHash!, confirmations: 5 });
  assert.equal(partial.status, "broadcasted");
  assert.equal(partial.confirmations, 5);
  const confirmed = await service.confirmTransfer({ network: "ethereum", txHash: sweep.txHash!, confirmations: 12 });
  assert.equal(confirmed.status, "confirmed");

  usdt = await usdtOf(service);
  assert.equal(usdt.hot, "150");
  assert.equal(usdt.internalInTransit, "1");
  assert.equal(usdt.total, "151");
});

test("a failed sweep releases its deposits for the next run", async () => {
  let fail = true;
  const { service, walletRepository } = setup({ failBroadcast: () => fail });
  await walletRepository.saveDeposit(deposit({ depositId: "d1", amount: "100" }));
  const first = await service.runSweeps();
  assert.equal(first.failedCount, 1);
  assert.equal(first.transfers[0]?.status, "failed");
  assert.match(first.transfers[0]?.lastError ?? "", /provider down/);
  assert.equal((await usdtOf(service)).depositAddresses, "100", "failed sweeps move nothing");

  fail = false;
  const second = await service.runSweeps();
  assert.equal(second.broadcastedCount, 1);
});

test("watermark proposals need a different approver and a funded source wallet", async () => {
  const { service } = setup();
  await service.recordGenesis({ assetCode: "USDT", walletType: "hot", amount: "9000", reference: "seed-hot" });
  await service.recordGenesis({ assetCode: "USDT", walletType: "cold", amount: "100000", reference: "seed-cold" });
  const replay = await service.recordGenesis({ assetCode: "USDT", walletType: "hot", amount: "9000", reference: "seed-hot" });
  assert.equal((await usdtOf(service)).hot, "9000", "genesis is idempotent by reference");
  assert.equal(replay.status, "confirmed");

  const evaluation = await service.evaluateWatermarks({ requestedBy: "ops-1" });
  assert.equal(evaluation.created.length, 1);
  const proposal = evaluation.created[0]!;
  assert.equal(proposal.kind, "rebalance_to_cold");
  assert.equal(proposal.amount, "6000", "back to the 3000 target");
  assert.equal(proposal.requestedBy, "system:watermark");

  const second = await service.evaluateWatermarks();
  assert.equal(second.created.length, 0, "one open rebalance per asset");

  const approved = await service.approveTransfer(proposal.transferId, { reviewedBy: "ops-1", note: "ok" });
  assert.equal(approved.status, "broadcasted");
  assert.equal((await usdtOf(service)).hot, "3000");
  assert.equal((await usdtOf(service)).internalInTransit, "6000");
  await service.confirmTransfer({ network: "ethereum", txHash: approved.txHash!, confirmations: 12 });
  const after = await usdtOf(service);
  assert.equal(after.cold, "106000");
  assert.equal(after.total, "109000");

  const manual = await service.proposeTransfer({
    kind: "rebalance_to_hot",
    assetCode: "usdt",
    amount: "500",
    requestedBy: "ops-1",
    reason: "drill"
  });
  await assert.rejects(
    service.approveTransfer(manual.transferId, { reviewedBy: "ops-1" }),
    (error: unknown) => error instanceof TreasuryError && error.code === "TREASURY_SAME_APPROVER"
  );
  const rejected = await service.rejectTransfer(manual.transferId, { reviewedBy: "ops-2", reason: "not needed" });
  assert.equal(rejected.status, "rejected");
  await assert.rejects(
    service.approveTransfer(manual.transferId, { reviewedBy: "ops-2" }),
    (error: unknown) => error instanceof TreasuryError && error.code === "TREASURY_INVALID_STATE"
  );

  const tooBig = await service.proposeTransfer({ kind: "rebalance_to_hot", assetCode: "USDT", amount: "999999", requestedBy: "ops-1" });
  await assert.rejects(
    service.approveTransfer(tooBig.transferId, { reviewedBy: "ops-2" }),
    (error: unknown) => error instanceof TreasuryError && error.code === "TREASURY_INSUFFICIENT_BALANCE"
  );
});

test("withdrawals are paid from the hot wallet and counted in flight until confirmed", async () => {
  const { service, walletRepository } = setup({ liabilities: [{ userId: "u1", balances: { USDT: "1000" } }] });
  await service.recordGenesis({ assetCode: "USDT", walletType: "hot", amount: "2000", reference: "seed" });
  await walletRepository.saveWithdrawal({
    withdrawalId: "w1",
    userId: "u1",
    ledgerAccountId: "acct-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0xdest",
    amount: "300",
    fee: "1",
    frozenAmount: "301",
    freezeReferenceId: "w1",
    status: "broadcasted",
    reviewStatus: "approved",
    requestedAt: "2026-01-01T00:00:00.000Z",
    txHash: "0xw1",
    metadata: {}
  });
  // A withdrawal auto-rejected by the KYT blacklist never left the hot wallet.
  await walletRepository.saveWithdrawal({
    withdrawalId: "w-blocked",
    userId: "u1",
    ledgerAccountId: "acct-1",
    assetCode: "USDT",
    network: "ethereum",
    toAddress: "0xbad0000000000000000000000000000000000001",
    amount: "500",
    fee: "1",
    frozenAmount: "0",
    freezeReferenceId: "w-blocked",
    status: "rejected",
    reviewStatus: "rejected",
    requestedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "blocked",
    metadata: {}
  } as Parameters<typeof walletRepository.saveWithdrawal>[0]);
  const report = await service.getReconciliation();
  const usdt = report.items.find((item) => item.assetCode === "USDT")!;
  assert.equal(usdt.hot, "1700");
  assert.equal(usdt.withdrawalsInFlight, "300");
  assert.equal(usdt.netLiabilities, "700");
  assert.equal(usdt.reserveRatio, "2.4285");
  assert.equal(report.status, "covered");
});

test("proof of reserves: every user gets a verifiable leaf, totals match the ledger", async () => {
  const users: Array<{ userId: string; balances: Record<string, string> }> = [
    { userId: "11111111-1111-1111-1111-111111111111", balances: { USDT: "1000", ETH: "1.5" } },
    { userId: "22222222-2222-2222-2222-222222222222", balances: { USDT: "250.25" } },
    { userId: "33333333-3333-3333-3333-333333333333", balances: { ETH: "0.5" } }
  ];
  const { service } = setup({ liabilities: users });
  assert.deepEqual(await service.getUserProof(users[0]!.userId), { available: false });

  await service.recordGenesis({ assetCode: "USDT", walletType: "cold", amount: "1500", reference: "c" });
  await service.recordGenesis({ assetCode: "ETH", walletType: "cold", amount: "1", reference: "e" });
  const snapshot = await service.generateProofOfReserves({ generatedBy: "ops@example.com" });
  assert.equal(snapshot.leafCount, 3);
  assert.equal(snapshot.treeDepth, 2);
  const usdt = snapshot.assets.find((item) => item.assetCode === "USDT")!;
  assert.equal(usdt.liabilities, "1250.25");
  assert.equal(usdt.reserves, "1500");
  assert.equal(usdt.status, "covered");
  const eth = snapshot.assets.find((item) => item.assetCode === "ETH")!;
  assert.equal(eth.liabilities, "2");
  assert.equal(eth.status, "shortfall");

  for (const user of users) {
    const proof = await service.getUserProof(user.userId);
    assert.equal(proof.available, true);
    assert.ok(proof.available && proof.included && proof.leaf);
    assert.equal(proof.snapshot.merkleRoot, snapshot.merkleRoot);
    assert.equal(proof.leaf.userHash, sha256Hex(`por-user:v1|${user.userId}|${proof.leaf.nonce}`));
    assert.equal(sha256Hex(proof.leaf.message), proof.leaf.leafHash);
    assert.ok(
      verifyMerkleProof({ leafHash: proof.leaf.leafHash, proof: proof.proof, merkleRoot: snapshot.merkleRoot, hash: sha256Hex })
    );
    const serialized = JSON.stringify(proof);
    for (const other of users.filter((item) => item.userId !== user.userId)) {
      assert.ok(!serialized.includes(other.userId), "other users' ids never leak");
    }
  }

  const stranger = await service.getUserProof("44444444-4444-4444-4444-444444444444");
  assert.equal(stranger.available, true);
  assert.equal(stranger.available && stranger.included, false);
});
