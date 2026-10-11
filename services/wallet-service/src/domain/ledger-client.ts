import type {
  LedgerConsumeBalanceCommand,
  LedgerDepositCreditCommand,
  LedgerFreezeBalanceCommand,
  LedgerReleaseBalanceCommand
} from "./types.js";

export interface LedgerClient {
  postDepositCredit(command: LedgerDepositCreditCommand): Promise<{ journalId: string }>;
  freezeBalance(command: LedgerFreezeBalanceCommand): Promise<{ lockId: string }>;
  releaseBalance(command: LedgerReleaseBalanceCommand): Promise<{ lockId: string }>;
  consumeBalance(command: LedgerConsumeBalanceCommand): Promise<{ lockId: string }>;
}
