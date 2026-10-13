import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  addAmounts,
  compareAmounts,
  fromAtomicUnits,
  getAssetDefinition,
  isKnownNetwork,
  listAssetDefinitions,
  toAtomicUnits
} from "@web3-cex/domain";
import type { AssetCode, Network } from "@web3-cex/domain";

import {
  POR_HASH_ALGORITHM,
  POR_LEAF_PREFIX,
  POR_NODE_PREFIX,
  POR_USER_PREFIX,
  buildProofOfReservesTree,
  leafMessage,
  type HashHex
} from "../domain/proof-of-reserves.js";
import type { TreasuryCustodyClient, TreasuryLedgerClient } from "../domain/treasury-clients.js";
import { TreasuryError } from "../domain/treasury-errors.js";
import {
  buildReserveReconciliation,
  computeTreasuryHoldings,
  evaluateHotWalletWatermark,
  planSweeps
} from "../domain/treasury-policy.js";
import type { TreasuryRepository } from "../domain/treasury-repository.js";
import type {
  ListTreasuryTransfersQuery,
  ProofOfReservesAsset,
  ProofOfReservesLeaf,
  ProofOfReservesSnapshot,
  ReserveReconciliationReport,
  TreasuryAssetHoldings,
  TreasuryConfig,
  TreasuryTransferKind,
  TreasuryTransferRecord,
  TreasuryTransferStatus,
  TreasuryWalletType,
  WatermarkEvaluation
} from "../domain/treasury-types.js";

export const SYSTEM_WATERMARK_ACTOR = "system:watermark";
export const SYSTEM_SWEEP_ACTOR = "system:sweep";

const OPEN_STATUSES: TreasuryTransferStatus[] = ["proposed", "approved", "broadcasted"];
const REBALANCE_KINDS: TreasuryTransferKind[] = ["rebalance_to_cold", "rebalance_to_hot"];
/** An `approved` transfer older than this was interrupted before its broadcast finished. */
const STUCK_APPROVED_MS = 60_000;

export function sha256Hex(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/** Deterministic demo address of the platform hot / cold wallet on a network. */
export function defaultTreasuryAddress(walletType: "hot" | "cold", network: Network): string {
  return `0x${sha256Hex(`treasury:${walletType}:${network}`).slice(0, 40)}`;
}

function normalize(amount: string): string {
  return fromAtomicUnits(toAtomicUnits(amount));
}

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  createNonce?: () => string;
  hash?: HashHex;
}

/**
 * Custody layering, sweeps, hot-wallet watermarks, wallet-vs-ledger
 * reconciliation and proof of reserves.
 *
 * Platform on-chain holdings are a separate book from the ledger: the ledger
 * records what the exchange owes users, this service records where the coins
 * are. Keeping the two independent is what makes the reconciliation
 * meaningful, so nothing here posts ledger journals (ledger reconciliation
 * stays untouched).
 */
export class TreasuryService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createNonce: () => string;
  private readonly hash: HashHex;

  constructor(
    private readonly repository: TreasuryRepository,
    private readonly custodyClient: TreasuryCustodyClient,
    private readonly ledgerClient: TreasuryLedgerClient,
    private readonly config: TreasuryConfig,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.createNonce = options.createNonce ?? (() => randomBytes(16).toString("hex"));
    this.hash = options.hash ?? sha256Hex;
  }

  // -------------------------------------------------------------------------
  // Holdings and overview
  // -------------------------------------------------------------------------

  async getHoldings(): Promise<TreasuryAssetHoldings[]> {
    const [creditedDeposits, sentWithdrawals, transferTotals] = await Promise.all([
      this.repository.sumCreditedDeposits(),
      this.repository.sumSentWithdrawals(),
      this.repository.listTransferTotals()
    ]);
    return computeTreasuryHoldings({
      creditedDeposits,
      sentWithdrawals,
      transferTotals,
      assets: listAssetDefinitions().map((asset) => ({
        assetCode: asset.code,
        network: asset.networks[0] ?? "ethereum"
      }))
    });
  }

  async getOverview() {
    const holdings = await this.getHoldings();
    const open = await this.repository.listTransfers({ statuses: OPEN_STATUSES, limit: 500 });
    const networks = [...new Set(holdings.map((item) => item.network))].sort();
    return {
      generatedAt: this.now().toISOString(),
      confirmationThreshold: this.config.confirmationThreshold,
      wallets: networks.map((network) => ({
        network,
        hotAddress: this.config.hotWalletAddress(network),
        coldAddress: this.config.coldWalletAddress(network)
      })),
      holdings: holdings.map((item) => ({
        ...item,
        watermark: this.config.watermarks[item.assetCode],
        watermarkState: this.evaluate(item, open.items).state
      })),
      openTransferCount: open.total,
      pendingApprovalCount: open.items.filter((item) => item.status === "proposed").length
    };
  }

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  listTransfers(query: ListTreasuryTransfersQuery) {
    return this.repository.listTransfers(query);
  }

  async getTransfer(transferId: string) {
    const transfer = await this.requireTransfer(transferId);
    const sweptDepositIds = transfer.kind === "sweep" ? await this.repository.listSweepDepositIds(transferId) : [];
    return { ...transfer, sweptDepositIds };
  }

  /**
   * Sweep job: one transfer per deposit address and asset, deposit -> hot.
   * Sweeps need no approval (the destination is the platform's own hot
   * wallet), they are broadcast through custody-adapter right away and the
   * demo chain reports their confirmations back.
   */
  async runSweeps(command: { requestedBy?: string } = {}) {
    const retried = await this.retryStuckApproved();
    const deposits = await this.repository.listUnsweptCreditedDeposits(this.config.sweepBatchSize);
    const plans = planSweeps(deposits, this.config.sweepMinAmounts);
    const created: TreasuryTransferRecord[] = [];
    const skipped: Array<{ fromAddress: string; assetCode: AssetCode; reason: string }> = [];

    for (const plan of plans) {
      const now = this.now().toISOString();
      const transferId = this.createId();
      const transfer = this.newTransfer({
        transferId,
        kind: "sweep",
        status: "approved",
        trigger: "sweep_job",
        assetCode: plan.assetCode,
        network: plan.network,
        amount: plan.amount,
        fromWallet: "deposit",
        fromAddress: plan.fromAddress,
        toWallet: "hot",
        idempotencyKey: `sweep:${transferId}`,
        requestedBy: SYSTEM_SWEEP_ACTOR,
        reason: `归集 ${plan.depositIds.length} 笔已入账充值`,
        metadata: { depositCount: plan.depositIds.length, triggeredBy: command.requestedBy ?? SYSTEM_SWEEP_ACTOR },
        now,
        event: { action: "sweep_created", actor: command.requestedBy ?? SYSTEM_SWEEP_ACTOR }
      });
      try {
        await this.repository.withTransaction(async (repository) => {
          await repository.insertTransfer(transfer);
          await repository.linkSweepDeposits(transferId, plan.depositIds, now);
        });
      } catch (error) {
        // Another sweep run took these deposits first.
        skipped.push({ fromAddress: plan.fromAddress, assetCode: plan.assetCode, reason: readMessage(error) });
        continue;
      }
      created.push(await this.broadcast(transfer, command.requestedBy ?? SYSTEM_SWEEP_ACTOR));
    }

    return {
      scannedDepositCount: deposits.length,
      plannedCount: plans.length,
      broadcastedCount: created.filter((item) => item.status === "broadcasted").length,
      failedCount: created.filter((item) => item.status === "failed").length,
      retriedCount: retried.length,
      transfers: created,
      skipped
    };
  }

  /**
   * Checks every asset against its hot wallet watermarks and creates a
   * `proposed` rebalance where needed. Proposals are always requested by
   * `system:watermark`, so any reviewer may approve them.
   */
  async evaluateWatermarks(command: { requestedBy?: string } = {}) {
    const holdings = await this.getHoldings();
    const open = await this.repository.listTransfers({ statuses: OPEN_STATUSES, limit: 500 });
    const evaluations: WatermarkEvaluation[] = [];
    const created: TreasuryTransferRecord[] = [];

    for (const item of holdings) {
      const evaluation = this.evaluate(item, open.items);
      evaluations.push(evaluation);
      if (!evaluation.proposal) {
        continue;
      }
      const sequence = await this.countRebalances(item.assetCode, item.network);
      const now = this.now().toISOString();
      const transferId = this.createId();
      const toCold = evaluation.proposal.kind === "rebalance_to_cold";
      const transfer = this.newTransfer({
        transferId,
        kind: evaluation.proposal.kind,
        status: "proposed",
        trigger: "watermark",
        assetCode: item.assetCode,
        network: item.network,
        amount: evaluation.proposal.amount,
        fromWallet: toCold ? "hot" : "cold",
        fromAddress: toCold ? this.config.hotWalletAddress(item.network) : this.config.coldWalletAddress(item.network),
        toWallet: toCold ? "cold" : "hot",
        // Same key for concurrent evaluators: only one proposal per slot.
        idempotencyKey: `watermark:${item.assetCode}:${item.network}:${sequence}`,
        requestedBy: SYSTEM_WATERMARK_ACTOR,
        reason: evaluation.proposal.reason,
        metadata: { watermark: evaluation.watermark, hotBefore: item.hot, coldBefore: item.cold, triggeredBy: command.requestedBy ?? SYSTEM_WATERMARK_ACTOR },
        now,
        event: { action: "proposed", actor: SYSTEM_WATERMARK_ACTOR, note: evaluation.proposal.reason }
      });
      try {
        await this.repository.insertTransfer(transfer);
        created.push(transfer);
      } catch (error) {
        evaluation.skippedReason = `并发创建被跳过：${readMessage(error)}`;
        delete evaluation.proposal;
      }
    }

    return { generatedAt: this.now().toISOString(), evaluations, created };
  }

  /** Manual rebalance proposal from an operator; another operator must approve it. */
  async proposeTransfer(command: {
    kind: string;
    assetCode: string;
    network?: string;
    amount: string;
    requestedBy: string;
    reason?: string;
  }): Promise<TreasuryTransferRecord> {
    if (!REBALANCE_KINDS.includes(command.kind as TreasuryTransferKind)) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "kind must be rebalance_to_cold or rebalance_to_hot");
    }
    if (!command.requestedBy) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "requestedBy is required");
    }
    const assetCode = String(command.assetCode ?? "").toUpperCase();
    const definition = getAssetDefinition(assetCode);
    if (!definition) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", `Unsupported asset ${command.assetCode}`);
    }
    const network = (command.network || definition.networks[0]) as Network;
    if (!isKnownNetwork(network) || !definition.networks.includes(network)) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", `${assetCode} is not configured on ${command.network}`);
    }
    const amount = this.requirePositiveAmount(command.amount);
    const kind = command.kind as Extract<TreasuryTransferKind, "rebalance_to_cold" | "rebalance_to_hot">;
    const toCold = kind === "rebalance_to_cold";
    const now = this.now().toISOString();
    const transferId = this.createId();
    const transfer = this.newTransfer({
      transferId,
      kind,
      status: "proposed",
      trigger: "manual",
      assetCode,
      network,
      amount,
      fromWallet: toCold ? "hot" : "cold",
      fromAddress: toCold ? this.config.hotWalletAddress(network) : this.config.coldWalletAddress(network),
      toWallet: toCold ? "cold" : "hot",
      idempotencyKey: `manual:${transferId}`,
      requestedBy: command.requestedBy,
      reason: command.reason?.trim() || "运营手动调拨",
      metadata: {},
      now,
      event: { action: "proposed", actor: command.requestedBy, note: command.reason }
    });
    await this.repository.insertTransfer(transfer);
    return transfer;
  }

  /**
   * Withdrawal-approval style review: the approver must differ from the
   * requester, the source wallet must hold the amount, then custody-adapter
   * broadcasts it.
   */
  async approveTransfer(transferId: string, command: { reviewedBy: string; note?: string }) {
    if (!command.reviewedBy) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "reviewedBy is required");
    }
    const transfer = await this.requireTransfer(transferId);
    if (transfer.status !== "proposed") {
      throw new TreasuryError("TREASURY_INVALID_STATE", `Transfer ${transferId} is ${transfer.status}, not proposed`);
    }
    if (transfer.requestedBy === command.reviewedBy) {
      throw new TreasuryError("TREASURY_SAME_APPROVER", "The operator who proposed a treasury transfer cannot approve it");
    }
    await this.assertSourceBalance(transfer);

    const now = this.now().toISOString();
    const approved: TreasuryTransferRecord = {
      ...transfer,
      status: "approved",
      reviewedBy: command.reviewedBy,
      reviewNote: command.note,
      approvedAt: now,
      updatedAt: now,
      events: [...transfer.events, { at: now, action: "approved", actor: command.reviewedBy, note: command.note, status: "approved" }]
    };
    await this.repository.updateTransfer(approved);
    return this.broadcast(approved, command.reviewedBy);
  }

  async rejectTransfer(transferId: string, command: { reviewedBy: string; reason?: string }) {
    if (!command.reviewedBy) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "reviewedBy is required");
    }
    const transfer = await this.requireTransfer(transferId);
    if (transfer.status !== "proposed") {
      throw new TreasuryError("TREASURY_INVALID_STATE", `Transfer ${transferId} is ${transfer.status}, not proposed`);
    }
    const now = this.now().toISOString();
    const rejected: TreasuryTransferRecord = {
      ...transfer,
      status: "rejected",
      reviewedBy: command.reviewedBy,
      reviewNote: command.reason,
      rejectedAt: now,
      updatedAt: now,
      events: [...transfer.events, { at: now, action: "rejected", actor: command.reviewedBy, note: command.reason, status: "rejected" }]
    };
    await this.repository.updateTransfer(rejected);
    return rejected;
  }

  /** Re-broadcasts a failed rebalance (failed sweeps are simply swept again). */
  async retryTransfer(transferId: string, command: { requestedBy: string }) {
    const transfer = await this.requireTransfer(transferId);
    if (transfer.status !== "failed" || transfer.kind === "sweep" || transfer.kind === "genesis") {
      throw new TreasuryError("TREASURY_INVALID_STATE", `Transfer ${transferId} (${transfer.kind}, ${transfer.status}) cannot be retried`);
    }
    await this.assertSourceBalance(transfer);
    return this.broadcast(transfer, command.requestedBy);
  }

  /**
   * Chain confirmation callback (the demo chain plays the scanner). Reaching
   * the threshold moves the amount from "in transit" into the target wallet.
   */
  async confirmTransfer(command: { network: string; txHash: string; confirmations: number; blockNumber?: number }) {
    if (!command.txHash || !isKnownNetwork(command.network)) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "network and txHash are required");
    }
    const confirmations = Math.max(0, Math.trunc(Number(command.confirmations ?? 0)));
    const transfer = await this.repository.findTransferByTxHash(command.network, command.txHash);
    if (!transfer) {
      throw new TreasuryError("TREASURY_TRANSFER_NOT_FOUND", `No treasury transfer with txHash ${command.txHash}`);
    }
    if (transfer.status !== "broadcasted") {
      // Already confirmed (replayed callback) or not on chain yet.
      return transfer;
    }
    const now = this.now().toISOString();
    const reached = confirmations >= this.config.confirmationThreshold;
    const updated: TreasuryTransferRecord = {
      ...transfer,
      confirmations: Math.max(transfer.confirmations, confirmations),
      blockNumber: command.blockNumber ?? transfer.blockNumber,
      status: reached ? "confirmed" : "broadcasted",
      confirmedAt: reached ? now : transfer.confirmedAt,
      updatedAt: now,
      events: reached
        ? [...transfer.events, { at: now, action: "confirmed", note: `${confirmations} confirmations`, status: "confirmed" }]
        : transfer.events
    };
    await this.repository.updateTransfer(updated);
    return updated;
  }

  /**
   * Records platform capital arriving on chain (demo bootstrap and the demo
   * reserve keeper mirror opening-balance seeding with it). Idempotent by
   * `reference`.
   */
  async recordGenesis(command: {
    assetCode: string;
    network?: string;
    walletType: string;
    amount: string;
    reference: string;
    requestedBy?: string;
    note?: string;
  }): Promise<TreasuryTransferRecord> {
    if (!command.reference) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "reference is required");
    }
    if (command.walletType !== "hot" && command.walletType !== "cold") {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "walletType must be hot or cold");
    }
    const assetCode = String(command.assetCode ?? "").toUpperCase();
    const definition = getAssetDefinition(assetCode);
    if (!definition) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", `Unsupported asset ${command.assetCode}`);
    }
    const network = (command.network || definition.networks[0]) as Network;
    const idempotencyKey = `genesis:${command.reference}`;
    const existing = await this.repository.findTransferByIdempotencyKey(idempotencyKey);
    if (existing) {
      return existing;
    }
    const amount = this.requirePositiveAmount(command.amount);
    const walletType = command.walletType as "hot" | "cold";
    const now = this.now().toISOString();
    const actor = command.requestedBy ?? "demo-bootstrap";
    const transfer = this.newTransfer({
      transferId: this.createId(),
      kind: "genesis",
      status: "confirmed",
      trigger: "genesis",
      assetCode,
      network,
      amount,
      fromWallet: "external",
      toWallet: walletType,
      idempotencyKey,
      requestedBy: actor,
      reason: command.note ?? "平台自有资金上链（演示注资）",
      metadata: { reference: command.reference },
      now,
      event: { action: "genesis_recorded", actor, note: command.note }
    });
    transfer.confirmedAt = now;
    transfer.events[0] = { ...transfer.events[0]!, status: "confirmed" };
    await this.repository.insertTransfer(transfer);
    return transfer;
  }

  // -------------------------------------------------------------------------
  // Reconciliation and proof of reserves
  // -------------------------------------------------------------------------

  async getReconciliation(): Promise<ReserveReconciliationReport & { holdings: TreasuryAssetHoldings[]; ledgerGeneratedAt: string; userCount: number }> {
    const [holdings, liabilities] = await Promise.all([this.getHoldings(), this.ledgerClient.getLiabilitySummary()]);
    const report = buildReserveReconciliation({
      generatedAt: this.now().toISOString(),
      holdings,
      liabilities: liabilities.assets
    });
    return { ...report, holdings, ledgerGeneratedAt: liabilities.generatedAt, userCount: liabilities.userCount };
  }

  async generateProofOfReserves(command: { generatedBy?: string } = {}): Promise<ProofOfReservesSnapshot> {
    const users = await this.ledgerClient.listUserLiabilities();
    const holdings = await this.getHoldings();
    const tree = buildProofOfReservesTree(
      users.items.map((item) => ({ userId: item.userId, nonce: this.createNonce(), balances: item.balances })),
      this.hash
    );

    const liabilityTotals = new Map<AssetCode, string>();
    for (const leaf of tree.leaves) {
      for (const [assetCode, amount] of Object.entries(leaf.canonical)) {
        liabilityTotals.set(assetCode, addAmounts(liabilityTotals.get(assetCode) ?? "0", amount));
      }
    }
    const report = buildReserveReconciliation({
      generatedAt: this.now().toISOString(),
      holdings,
      liabilities: [...liabilityTotals.entries()].map(([assetCode, total]) => ({ assetCode, total }))
    });
    const assets: ProofOfReservesAsset[] = report.items.map((item) => ({
      assetCode: item.assetCode,
      liabilities: item.ledgerLiabilities,
      withdrawalsInFlight: item.withdrawalsInFlight,
      netLiabilities: item.netLiabilities,
      reserves: item.reserves,
      hot: item.hot,
      cold: item.cold,
      depositAddresses: item.depositAddresses,
      internalInTransit: item.internalInTransit,
      reserveRatio: item.reserveRatio,
      status: item.status
    }));

    const snapshot: ProofOfReservesSnapshot = {
      snapshotId: this.createId(),
      merkleRoot: tree.merkleRoot,
      leafCount: tree.leaves.length,
      treeDepth: tree.treeDepth,
      assets,
      generatedBy: command.generatedBy ?? "system",
      createdAt: this.now().toISOString()
    };
    const leaves: ProofOfReservesLeaf[] = tree.leaves.map((leaf) => ({
      snapshotId: snapshot.snapshotId,
      userId: leaf.userId,
      leafIndex: leaf.leafIndex,
      nonce: leaf.nonce,
      userHash: leaf.userHash,
      balances: leaf.canonical,
      leafHash: leaf.leafHash,
      proof: leaf.proof
    }));
    await this.repository.withTransaction((repository) => repository.saveProofOfReservesSnapshot(snapshot, leaves));
    return snapshot;
  }

  listProofOfReservesSnapshots(limit = 20) {
    return this.repository.listProofOfReservesSnapshots(limit);
  }

  async getProofOfReservesSnapshot(snapshotId: string) {
    const snapshot = await this.repository.findProofOfReservesSnapshot(snapshotId);
    if (!snapshot) {
      throw new TreasuryError("POR_SNAPSHOT_NOT_FOUND", `Snapshot ${snapshotId} not found`);
    }
    return { ...snapshot, format: POR_FORMAT };
  }

  /**
   * The caller's own leaf and Merkle path in the latest snapshot. Other
   * users' leaves are never returned: the path only contains sibling hashes.
   */
  async getUserProof(userId: string) {
    if (!userId) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", "userId is required");
    }
    const snapshot = await this.repository.findLatestProofOfReservesSnapshot();
    if (!snapshot) {
      return { available: false as const };
    }
    const leaf = await this.repository.findProofOfReservesLeaf(snapshot.snapshotId, userId);
    return {
      available: true as const,
      snapshot: { ...snapshot, format: POR_FORMAT },
      included: Boolean(leaf),
      leaf: leaf
        ? {
            userId: leaf.userId,
            nonce: leaf.nonce,
            userHash: leaf.userHash,
            balances: leaf.balances,
            leafIndex: leaf.leafIndex,
            leafHash: leaf.leafHash,
            message: leafMessage(leaf.userHash, leaf.balances)
          }
        : undefined,
      proof: leaf?.proof ?? []
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private evaluate(item: TreasuryAssetHoldings, openTransfers: TreasuryTransferRecord[]): WatermarkEvaluation {
    return evaluateHotWalletWatermark({
      holdings: item,
      watermark: this.config.watermarks[item.assetCode],
      hasOpenRebalance: openTransfers.some(
        (transfer) =>
          REBALANCE_KINDS.includes(transfer.kind) &&
          transfer.assetCode === item.assetCode &&
          transfer.network === item.network &&
          OPEN_STATUSES.includes(transfer.status)
      )
    });
  }

  private async countRebalances(assetCode: AssetCode, network: Network): Promise<number> {
    const [toCold, toHot] = await Promise.all(
      REBALANCE_KINDS.map((kind) => this.repository.listTransfers({ kind, assetCode, network, limit: 1 }))
    );
    return (toCold?.total ?? 0) + (toHot?.total ?? 0);
  }

  private async assertSourceBalance(transfer: TreasuryTransferRecord): Promise<void> {
    if (transfer.fromWallet === "external" || transfer.fromWallet === "deposit") {
      return;
    }
    const holdings = (await this.getHoldings()).find(
      (item) => item.assetCode === transfer.assetCode && item.network === transfer.network
    );
    const available = holdings?.[transfer.fromWallet as Exclude<TreasuryWalletType, "deposit">] ?? "0";
    if (compareAmounts(available, transfer.amount) < 0) {
      throw new TreasuryError(
        "TREASURY_INSUFFICIENT_BALANCE",
        `${transfer.fromWallet} wallet holds ${available} ${transfer.assetCode}, cannot send ${transfer.amount}`
      );
    }
  }

  private async retryStuckApproved(): Promise<TreasuryTransferRecord[]> {
    const approved = await this.repository.listTransfers({ status: "approved", limit: 100 });
    const cutoff = this.now().getTime() - STUCK_APPROVED_MS;
    const retried: TreasuryTransferRecord[] = [];
    for (const transfer of approved.items.filter((item) => Date.parse(item.updatedAt) < cutoff)) {
      retried.push(await this.broadcast(transfer, SYSTEM_SWEEP_ACTOR));
    }
    return retried;
  }

  private async broadcast(transfer: TreasuryTransferRecord, actor: string): Promise<TreasuryTransferRecord> {
    const attempt = Number(transfer.metadata.broadcastAttempts ?? 0) + 1;
    try {
      const result = await this.custodyClient.broadcastInternalTransfer({
        transferId: transfer.transferId,
        attempt,
        assetCode: transfer.assetCode,
        network: transfer.network,
        fromAddress: transfer.fromAddress,
        toAddress: transfer.toAddress,
        amount: transfer.amount,
        metadata: {
          purpose: `treasury_${transfer.kind}`,
          fromWallet: transfer.fromWallet,
          toWallet: transfer.toWallet,
          // Cold wallet keys are offline in reality; the demo signs through custody too.
          signer: transfer.fromWallet === "cold" ? "cold-wallet (simulated offline signing)" : "hot-wallet"
        }
      });
      const now = this.now().toISOString();
      const broadcasted: TreasuryTransferRecord = {
        ...transfer,
        status: "broadcasted",
        custodyTransferId: result.custodyTransferId,
        providerName: result.providerName,
        txHash: result.txHash,
        confirmations: 0,
        lastError: undefined,
        broadcastedAt: now,
        updatedAt: now,
        metadata: { ...transfer.metadata, broadcastAttempts: attempt },
        events: [...transfer.events, { at: now, action: "broadcasted", actor, note: result.txHash, status: "broadcasted" }]
      };
      await this.repository.updateTransfer(broadcasted);
      return broadcasted;
    } catch (error) {
      const now = this.now().toISOString();
      const failed: TreasuryTransferRecord = {
        ...transfer,
        status: "failed",
        lastError: readMessage(error),
        failedAt: now,
        updatedAt: now,
        metadata: { ...transfer.metadata, broadcastAttempts: attempt },
        events: [...transfer.events, { at: now, action: "broadcast_failed", actor, note: readMessage(error), status: "failed" }]
      };
      await this.repository.withTransaction(async (repository) => {
        await repository.updateTransfer(failed);
        if (failed.kind === "sweep") {
          // The deposits go back to the pool and are swept by the next run.
          await repository.unlinkSweepDeposits(failed.transferId);
        }
      });
      return failed;
    }
  }

  private newTransfer(input: {
    transferId: string;
    kind: TreasuryTransferKind;
    status: TreasuryTransferStatus;
    trigger: TreasuryTransferRecord["trigger"];
    assetCode: AssetCode;
    network: Network;
    amount: string;
    fromWallet: TreasuryTransferRecord["fromWallet"];
    fromAddress?: string;
    toWallet: TreasuryTransferRecord["toWallet"];
    idempotencyKey: string;
    requestedBy: string;
    reason?: string;
    metadata: Record<string, unknown>;
    now: string;
    event: { action: string; actor?: string; note?: string };
  }): TreasuryTransferRecord {
    return {
      transferId: input.transferId,
      kind: input.kind,
      status: input.status,
      trigger: input.trigger,
      assetCode: input.assetCode,
      network: input.network,
      amount: normalize(input.amount),
      fromWallet: input.fromWallet,
      fromAddress: input.fromAddress,
      toWallet: input.toWallet,
      toAddress:
        input.toWallet === "hot" ? this.config.hotWalletAddress(input.network) : this.config.coldWalletAddress(input.network),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      requestedBy: input.requestedBy,
      confirmations: 0,
      events: [{ at: input.now, ...input.event, status: input.status }],
      metadata: input.metadata,
      createdAt: input.now,
      updatedAt: input.now
    };
  }

  private requirePositiveAmount(value: string): string {
    const text = String(value ?? "").trim();
    if (!/^\d+(\.\d{1,18})?$/.test(text) || compareAmounts(text, "0") <= 0) {
      throw new TreasuryError("TREASURY_INVALID_REQUEST", `amount must be a positive decimal, got ${value}`);
    }
    return normalize(text);
  }

  private async requireTransfer(transferId: string): Promise<TreasuryTransferRecord> {
    const transfer = await this.repository.findTransferById(transferId);
    if (!transfer) {
      throw new TreasuryError("TREASURY_TRANSFER_NOT_FOUND", `Treasury transfer ${transferId} not found`);
    }
    return transfer;
  }
}

export const POR_FORMAT = {
  hashAlgorithm: POR_HASH_ALGORITHM,
  userHash: `SHA-256("${POR_USER_PREFIX}|" + userId + "|" + nonce)`,
  leaf: `SHA-256("${POR_LEAF_PREFIX}|" + userHash + "|" + "ASSET=amount,..." 按币种排序)`,
  node: `SHA-256("${POR_NODE_PREFIX}|" + left + "|" + right)，奇数个节点时最后一个与自身配对`
};

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
