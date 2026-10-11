import type {
  DepositRecord,
  WalletNotificationRecord,
  WithdrawalRecord
} from "./types.js";

export interface WalletEventPublisher {
  publishDepositUpdated(deposit: DepositRecord): Promise<void>;
  publishWithdrawalUpdated(withdrawal: WithdrawalRecord): Promise<void>;
  publishNotificationCreated(notification: WalletNotificationRecord): Promise<void>;
  close?(): Promise<void>;
}
