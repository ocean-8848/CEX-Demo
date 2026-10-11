import type { AssetCode } from "@web3-cex/domain";

import type { LedgerBalanceSnapshot } from "./types.js";

export interface RiskLedgerClient {
  getBalance(accountId: string, assetCode: AssetCode): Promise<LedgerBalanceSnapshot>;
}
