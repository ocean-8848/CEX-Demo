/**
 * 钱包与储备金: custody layering (deposit addresses -> hot <-> cold),
 * sweeps, hot wallet watermark proposals, wallet-vs-ledger reconciliation
 * and proof-of-reserves snapshots. wallet-service owns all of it; the BFF
 * only adds permissions and the ops action audit log.
 */
export interface OpsTreasuryClient {
  getOverview(): Promise<Record<string, unknown>>;
  listTransfers(query: Record<string, string | number | undefined>): Promise<Record<string, unknown>>;
  getTransfer(transferId: string): Promise<Record<string, unknown>>;
  proposeTransfer(command: {
    kind: string;
    assetCode: string;
    network?: string;
    amount: string;
    reason?: string;
    requestedBy: string;
  }): Promise<Record<string, unknown>>;
  approveTransfer(transferId: string, command: { reviewedBy: string; note?: string }): Promise<Record<string, unknown>>;
  rejectTransfer(transferId: string, command: { reviewedBy: string; reason?: string }): Promise<Record<string, unknown>>;
  retryTransfer(transferId: string, command: { requestedBy: string }): Promise<Record<string, unknown>>;
  runSweeps(command: { requestedBy: string }): Promise<Record<string, unknown>>;
  evaluateWatermarks(command: { requestedBy: string }): Promise<Record<string, unknown>>;
  getReconciliation(): Promise<Record<string, unknown>>;
  generateProofOfReserves(command: { generatedBy: string }): Promise<Record<string, unknown>>;
  listProofOfReservesSnapshots(limit?: number): Promise<Record<string, unknown>>;
  getProofOfReservesSnapshot(snapshotId: string): Promise<Record<string, unknown>>;
}

/** Reading the treasury: the ledger readers (finance, admin, observer). */
export const TREASURY_READ_PERMISSION = "ops.ledger.read";
/** Running jobs, proposing transfers, generating PoR snapshots. */
export const TREASURY_EXECUTE_PERMISSION = "ops.ledger.execute";
/** Approving / rejecting a proposed hot <-> cold transfer: the withdrawal reviewers. */
export const TREASURY_REVIEW_PERMISSION = "ops.withdrawals.review";
