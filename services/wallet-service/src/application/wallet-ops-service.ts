import type { WalletApplicationService } from "./wallet-application-service.js";
import { WalletNotificationDispatcher } from "./wallet-notification-dispatcher.js";

export interface WalletNotificationDeliveryResult {
  deliveredCount: number;
  retriedCount: number;
  failedCount: number;
  notificationIds: string[];
}

export interface WalletStaleWithdrawalRepairResult {
  staleMinutes: number;
  scannedCount: number;
  rejectedCount: number;
  rebroadcastedCount: number;
  confirmedCount: number;
  skippedCount: number;
  processedWithdrawalIds: string[];
}

export class WalletOpsService {
  constructor(
    private readonly walletService: WalletApplicationService,
    private readonly dispatcher: WalletNotificationDispatcher,
    private readonly now: () => Date = () => new Date()
  ) {}

  async deliverNotifications(limit?: number): Promise<WalletNotificationDeliveryResult> {
    return this.dispatcher.deliverPending(limit);
  }

  async reconcileStaleWithdrawals(params: {
    staleMinutes?: number;
    rebroadcastAutoConfirm?: boolean;
    forceConfirmations?: number;
    forceBlockNumber?: number;
    pageSize?: number;
    operatorId?: string;
  } = {}): Promise<WalletStaleWithdrawalRepairResult> {
    const staleMinutes = params.staleMinutes ?? 30;
    const rebroadcastAutoConfirm = params.rebroadcastAutoConfirm ?? false;
    const forceConfirmations = params.forceConfirmations ?? 0;
    const forceBlockNumber = params.forceBlockNumber ?? 0;
    const pageSize = params.pageSize ?? 100;
    const cutoff = this.now().getTime() - staleMinutes * 60_000;
    const operatorId = params.operatorId ?? "system:stale-cleanup";

    let offset = 0;
    let scannedCount = 0;
    let rejectedCount = 0;
    let rebroadcastedCount = 0;
    let confirmedCount = 0;
    let skippedCount = 0;
    const processedWithdrawalIds: string[] = [];

    while (true) {
      const page = await this.walletService.listWithdrawals({
        limit: pageSize,
        offset
      });

      if (page.items.length === 0) {
        break;
      }

      for (const withdrawal of page.items) {
        scannedCount += 1;

        const requestedAt = Date.parse(withdrawal.requestedAt);
        if (!Number.isFinite(requestedAt) || requestedAt > cutoff) {
          continue;
        }

        if (
          (withdrawal.status === "requested" || withdrawal.status === "under_review") &&
          (withdrawal.reviewStatus === "pending" ||
            withdrawal.reviewStatus === "pending_second_approval")
        ) {
          await this.walletService.rejectWithdrawal({
            withdrawalId: withdrawal.withdrawalId,
            reviewedBy: operatorId,
            reason: "stale withdrawal cleanup"
          });
          rejectedCount += 1;
          processedWithdrawalIds.push(withdrawal.withdrawalId);
          continue;
        }

        if (withdrawal.status === "approved" && withdrawal.reviewStatus === "approved") {
          const rebroadcasted = await this.walletService.rebroadcastWithdrawal({
            withdrawalId: withdrawal.withdrawalId,
            requestedBy: operatorId,
            note: "resume stale approved withdrawal"
          });

          rebroadcastedCount += 1;
          processedWithdrawalIds.push(withdrawal.withdrawalId);

          const providerName =
            typeof rebroadcasted.metadata.broadcast === "object" &&
            rebroadcasted.metadata.broadcast &&
            "providerName" in rebroadcasted.metadata.broadcast
              ? String(
                  (rebroadcasted.metadata.broadcast as Record<string, unknown>).providerName ?? ""
                )
              : undefined;

          if (rebroadcastAutoConfirm && providerName?.startsWith("mock-custody") && rebroadcasted.txHash) {
            await this.walletService.confirmWithdrawal({
              network: rebroadcasted.network,
              txHash: rebroadcasted.txHash,
              confirmations: forceConfirmations > 0 ? forceConfirmations : 12,
              blockNumber: forceBlockNumber || undefined
            });
            confirmedCount += 1;
          }
          continue;
        }

        if (withdrawal.status === "broadcasted" && withdrawal.txHash && forceConfirmations > 0) {
          await this.walletService.confirmWithdrawal({
            network: withdrawal.network,
            txHash: withdrawal.txHash,
            confirmations: forceConfirmations,
            blockNumber: forceBlockNumber || undefined
          });
          confirmedCount += 1;
          processedWithdrawalIds.push(withdrawal.withdrawalId);
          continue;
        }

        skippedCount += 1;
      }

      offset += page.items.length;
    }

    return {
      staleMinutes,
      scannedCount,
      rejectedCount,
      rebroadcastedCount,
      confirmedCount,
      skippedCount,
      processedWithdrawalIds
    };
  }
}
