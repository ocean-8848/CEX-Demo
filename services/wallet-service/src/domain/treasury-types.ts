import type { AssetCode, Network } from "@web3-cex/domain";

/**
 * Custody layering: where the platform's on-chain coins sit.
 *
 * - `deposit`: the per-user deposit addresses (credited but not yet swept)
 * - `hot`: online hot wallet, pays withdrawals automatically
 * - `cold`: offline cold wallet, long-term reserve
 * - `external`: outside the platform (only as the source of a genesis transfer)
 */
export type TreasuryWalletType = "deposit" | "hot" | "cold";
export type TreasuryTransferSource = TreasuryWalletType | "external";

/**
 * - `genesis`: platform capital put on chain (demo bootstrap / reserve keeper)
 * - `sweep`: deposit address -> hot wallet (归集)
 * - `rebalance_to_cold`: hot -> cold when the hot wallet is above its upper watermark
 * - `rebalance_to_hot`: cold -> hot when the hot wallet is below its lower watermark
 */
export type TreasuryTransferKind = "genesis" | "sweep" | "rebalance_to_cold" | "rebalance_to_hot";

/**
 * proposed -> approved -> broadcasted -> confirmed
 *        \-> rejected        \-> failed (broadcast error)
 * Sweeps skip `proposed` (internal destination, automated); genesis transfers
 * are recorded as `confirmed` directly.
 */
export type TreasuryTransferStatus =
  | "proposed"
  | "approved"
  | "broadcasted"
  | "confirmed"
  | "rejected"
  | "failed";

export type TreasuryTransferTrigger = "watermark" | "manual" | "sweep_job" | "genesis";

export interface TreasuryTransferEvent {
  at: string;
  action: string;
  actor?: string;
  note?: string;
  status: TreasuryTransferStatus;
}

export interface TreasuryTransferRecord {
  transferId: string;
  kind: TreasuryTransferKind;
  status: TreasuryTransferStatus;
  trigger: TreasuryTransferTrigger;
  assetCode: AssetCode;
  network: Network;
  amount: string;
  fromWallet: TreasuryTransferSource;
  toWallet: Exclude<TreasuryWalletType, "deposit">;
  fromAddress?: string;
  toAddress: string;
  idempotencyKey: string;
  reason?: string;
  requestedBy: string;
  reviewedBy?: string;
  reviewNote?: string;
  custodyTransferId?: string;
  providerName?: string;
  txHash?: string;
  confirmations: number;
  blockNumber?: number;
  lastError?: string;
  events: TreasuryTransferEvent[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  broadcastedAt?: string;
  confirmedAt?: string;
  rejectedAt?: string;
  failedAt?: string;
}

export interface ListTreasuryTransfersQuery {
  kind?: TreasuryTransferKind;
  status?: TreasuryTransferStatus;
  statuses?: TreasuryTransferStatus[];
  assetCode?: AssetCode;
  network?: Network;
  txHash?: string;
  limit?: number;
  offset?: number;
}

/** Sum of transfer amounts per (kind, from, to, asset, network, status). */
export interface TreasuryTransferTotal {
  kind: TreasuryTransferKind;
  fromWallet: TreasuryTransferSource;
  toWallet: Exclude<TreasuryWalletType, "deposit">;
  assetCode: AssetCode;
  network: Network;
  status: TreasuryTransferStatus;
  amount: string;
  count: number;
}

export interface AssetNetworkAmount {
  assetCode: AssetCode;
  network: Network;
  amount: string;
  count: number;
}

/** Withdrawals that already left the hot wallet on chain (status broadcasted / confirmed). */
export interface SentWithdrawalTotal {
  assetCode: AssetCode;
  network: Network;
  status: "broadcasted" | "confirmed";
  amount: string;
  fee: string;
  count: number;
}

export interface UnsweptDeposit {
  depositId: string;
  userId: string;
  assetCode: AssetCode;
  network: Network;
  address: string;
  amount: string;
  creditedAt?: string;
}

export interface HotWalletWatermark {
  low: string;
  high: string;
  /** Where a rebalance brings the hot wallet back to: (low + high) / 2. */
  target: string;
}

/** On-chain platform holdings of one asset on one network. */
export interface TreasuryAssetHoldings {
  assetCode: AssetCode;
  network: Network;
  /** Credited deposits still sitting in user deposit addresses. */
  depositAddresses: string;
  hot: string;
  cold: string;
  /** Internal transfers (sweep / rebalance) broadcast but not yet confirmed. */
  internalInTransit: string;
  /** depositAddresses + hot + cold + internalInTransit. */
  total: string;
  /** Withdrawals broadcast from the hot wallet whose ledger lock is not consumed yet. */
  withdrawalsInFlight: string;
  withdrawalsInFlightCount: number;
  /** Genesis capital put on chain (hot + cold), for explanation only. */
  genesis: string;
}

export type WatermarkState = "unconfigured" | "below_low" | "within" | "above_high";

export interface WatermarkEvaluation {
  assetCode: AssetCode;
  network: Network;
  state: WatermarkState;
  hot: string;
  cold: string;
  watermark?: HotWalletWatermark;
  /** Why no proposal was created (open transfer exists, cold wallet empty ...). */
  skippedReason?: string;
  proposal?: {
    kind: Extract<TreasuryTransferKind, "rebalance_to_cold" | "rebalance_to_hot">;
    amount: string;
    reason: string;
  };
}

export type ReserveStatus = "covered" | "shortfall" | "no_liabilities";

export interface ReserveReconciliationItem {
  assetCode: AssetCode;
  networks: Network[];
  depositAddresses: string;
  hot: string;
  cold: string;
  internalInTransit: string;
  /** On-chain platform holdings: deposit addresses + hot + cold + internal in transit. */
  reserves: string;
  /** ledger: user-owned accounts, available + locked. */
  ledgerLiabilities: string;
  /** Broadcast withdrawals: already paid on chain, still locked in the ledger. */
  withdrawalsInFlight: string;
  /** ledgerLiabilities - withdrawalsInFlight. */
  netLiabilities: string;
  /** reserves - netLiabilities (platform equity on chain: genesis capital, collected fees). */
  surplus: string;
  /** reserves / netLiabilities, 4 decimals; undefined without liabilities. */
  reserveRatio?: string;
  /** hot / netLiabilities, 4 decimals. */
  hotCoverage?: string;
  status: ReserveStatus;
}

export interface ReserveReconciliationReport {
  generatedAt: string;
  status: "covered" | "shortfall";
  shortfallCount: number;
  items: ReserveReconciliationItem[];
}

export interface ProofStep {
  /** Where the sibling sits: hash(left || right). */
  position: "left" | "right";
  hash: string;
}

export interface ProofOfReservesAsset {
  assetCode: AssetCode;
  /** Sum of all leaves (= ledger user liabilities at snapshot time). */
  liabilities: string;
  withdrawalsInFlight: string;
  netLiabilities: string;
  reserves: string;
  hot: string;
  cold: string;
  depositAddresses: string;
  internalInTransit: string;
  reserveRatio?: string;
  status: ReserveStatus;
}

export interface ProofOfReservesSnapshot {
  snapshotId: string;
  merkleRoot: string;
  leafCount: number;
  treeDepth: number;
  assets: ProofOfReservesAsset[];
  generatedBy: string;
  createdAt: string;
}

export interface ProofOfReservesLeaf {
  snapshotId: string;
  userId: string;
  leafIndex: number;
  nonce: string;
  userHash: string;
  balances: Record<AssetCode, string>;
  leafHash: string;
  proof: ProofStep[];
}

export interface TreasuryConfig {
  watermarks: Record<AssetCode, HotWalletWatermark>;
  sweepMinAmounts: Record<AssetCode, string>;
  confirmationThreshold: number;
  sweepBatchSize: number;
  hotWalletAddress: (network: Network) => string;
  coldWalletAddress: (network: Network) => string;
}
