import type { OpsSessionInfo } from "../domain/clients.js";
import {
  TREASURY_EXECUTE_PERMISSION,
  TREASURY_REVIEW_PERMISSION,
  type OpsTreasuryClient
} from "../domain/treasury.js";
import type { AuditedActionOptions } from "./ops-console-application-service.js";

type AuditedRunner = <T>(options: AuditedActionOptions, operation: () => Promise<T>) => Promise<T>;

/**
 * 钱包与储备金 page. Reads pass through; every action is written to the ops
 * action audit log. The operator (email, falling back to user id) is sent as
 * requestedBy / reviewedBy so wallet-service can enforce that whoever
 * proposed a transfer does not approve it.
 */
export class TreasuryApplicationService {
  constructor(
    private readonly client: OpsTreasuryClient,
    private readonly runAudited: AuditedRunner
  ) {}

  getOverview() {
    return this.client.getOverview();
  }

  listTransfers(query: Record<string, string | number | undefined>) {
    return this.client.listTransfers(query);
  }

  getTransfer(transferId: string) {
    return this.client.getTransfer(transferId);
  }

  getReconciliation() {
    return this.client.getReconciliation();
  }

  listProofOfReservesSnapshots(limit?: number) {
    return this.client.listProofOfReservesSnapshots(limit);
  }

  getProofOfReservesSnapshot(snapshotId: string) {
    return this.client.getProofOfReservesSnapshot(snapshotId);
  }

  runSweeps(session: OpsSessionInfo) {
    const payload = { requestedBy: operatorLabel(session) };
    return this.audit(session, TREASURY_EXECUTE_PERMISSION, "treasury.sweep.run", "treasury", "sweep", payload, () =>
      this.client.runSweeps(payload)
    );
  }

  evaluateWatermarks(session: OpsSessionInfo) {
    const payload = { requestedBy: operatorLabel(session) };
    return this.audit(session, TREASURY_EXECUTE_PERMISSION, "treasury.watermark.evaluate", "treasury", "watermark", payload, () =>
      this.client.evaluateWatermarks(payload)
    );
  }

  proposeTransfer(
    session: OpsSessionInfo,
    command: { kind?: string; assetCode?: string; network?: string; amount?: string; reason?: string }
  ) {
    const payload = {
      kind: String(command.kind ?? ""),
      assetCode: String(command.assetCode ?? ""),
      network: command.network || undefined,
      amount: String(command.amount ?? ""),
      reason: command.reason || undefined,
      requestedBy: operatorLabel(session)
    };
    return this.audit(session, TREASURY_EXECUTE_PERMISSION, "treasury.transfer.propose", "treasury_transfer", payload.assetCode, payload, () =>
      this.client.proposeTransfer(payload)
    );
  }

  approveTransfer(session: OpsSessionInfo, transferId: string, command: { note?: string }) {
    const payload = { reviewedBy: operatorLabel(session), note: command.note || undefined };
    return this.audit(session, TREASURY_REVIEW_PERMISSION, "treasury.transfer.approve", "treasury_transfer", transferId, payload, () =>
      this.client.approveTransfer(transferId, payload)
    );
  }

  rejectTransfer(session: OpsSessionInfo, transferId: string, command: { reason?: string }) {
    const payload = { reviewedBy: operatorLabel(session), reason: command.reason || undefined };
    return this.audit(session, TREASURY_REVIEW_PERMISSION, "treasury.transfer.reject", "treasury_transfer", transferId, payload, () =>
      this.client.rejectTransfer(transferId, payload)
    );
  }

  retryTransfer(session: OpsSessionInfo, transferId: string) {
    const payload = { requestedBy: operatorLabel(session) };
    return this.audit(session, TREASURY_EXECUTE_PERMISSION, "treasury.transfer.retry", "treasury_transfer", transferId, payload, () =>
      this.client.retryTransfer(transferId, payload)
    );
  }

  generateProofOfReserves(session: OpsSessionInfo) {
    const payload = { generatedBy: operatorLabel(session) };
    return this.audit(session, TREASURY_EXECUTE_PERMISSION, "treasury.por.generate", "proof_of_reserves", "snapshot", payload, () =>
      this.client.generateProofOfReserves(payload)
    );
  }

  private audit<T>(
    session: OpsSessionInfo,
    permission: string,
    action: string,
    targetType: string,
    targetId: string,
    requestPayload: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.runAudited(
      {
        session,
        permission,
        action,
        targetType,
        targetId,
        requestPayload: JSON.parse(JSON.stringify(requestPayload)) as Record<string, unknown>
      },
      operation
    );
  }
}

export function operatorLabel(session: OpsSessionInfo): string {
  return session.email ?? session.userId;
}
