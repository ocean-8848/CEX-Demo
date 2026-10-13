import { addAmounts, compareAmounts, fromAtomicUnits, toAtomicUnits } from "@web3-cex/domain";
import type { AssetCode } from "@web3-cex/domain";

/**
 * User liabilities: what the exchange owes its customers, per asset.
 *
 * A balance row is a customer liability when its account belongs to a user
 * (`accounts.user_id` is set). Platform accounts - opening balance (equity),
 * the deposit-source treasury, settlement and fee accounts - have no user and
 * are excluded. Both available and locked count: a frozen order or withdrawal
 * is still the customer's money until it is consumed.
 *
 * wallet-service compares these totals with on-chain platform holdings
 * (wallet-vs-ledger reconciliation) and builds the proof-of-reserves Merkle
 * tree from the per-user rows.
 */
export interface LedgerUserBalanceRow {
  userId: string;
  assetCode: AssetCode;
  available: string;
  locked: string;
}

export interface LedgerAssetLiability {
  assetCode: AssetCode;
  available: string;
  locked: string;
  total: string;
  /** Users holding a non-zero balance of this asset. */
  userCount: number;
}

export interface LedgerLiabilitySummary {
  generatedAt: string;
  userCount: number;
  assets: LedgerAssetLiability[];
}

export interface LedgerUserLiability {
  userId: string;
  /** asset -> available + locked (non-zero only, normalized decimals). */
  balances: Record<AssetCode, string>;
}

export interface LedgerUserLiabilityList {
  generatedAt: string;
  items: LedgerUserLiability[];
}

function normalize(amount: string): string {
  return fromAtomicUnits(toAtomicUnits(amount));
}

export function buildLiabilitySummary(params: {
  generatedAt: string;
  rows: LedgerUserBalanceRow[];
}): LedgerLiabilitySummary {
  const byAsset = new Map<AssetCode, { available: string; locked: string; users: Set<string> }>();
  const users = new Set<string>();

  for (const row of params.rows) {
    const total = addAmounts(row.available, row.locked);
    const entry = byAsset.get(row.assetCode) ?? { available: "0", locked: "0", users: new Set<string>() };
    entry.available = addAmounts(entry.available, row.available);
    entry.locked = addAmounts(entry.locked, row.locked);
    if (compareAmounts(total, "0") !== 0) {
      entry.users.add(row.userId);
      users.add(row.userId);
    }
    byAsset.set(row.assetCode, entry);
  }

  return {
    generatedAt: params.generatedAt,
    userCount: users.size,
    assets: [...byAsset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetCode, entry]) => ({
        assetCode,
        available: normalize(entry.available),
        locked: normalize(entry.locked),
        total: normalize(addAmounts(entry.available, entry.locked)),
        userCount: entry.users.size
      }))
  };
}

export function buildUserLiabilities(params: {
  generatedAt: string;
  rows: LedgerUserBalanceRow[];
}): LedgerUserLiabilityList {
  const byUser = new Map<string, Map<AssetCode, string>>();

  for (const row of params.rows) {
    const balances = byUser.get(row.userId) ?? new Map<AssetCode, string>();
    balances.set(
      row.assetCode,
      addAmounts(balances.get(row.assetCode) ?? "0", addAmounts(row.available, row.locked))
    );
    byUser.set(row.userId, balances);
  }

  const items: LedgerUserLiability[] = [];
  for (const [userId, balances] of [...byUser.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const nonZero = [...balances.entries()]
      .filter(([, amount]) => compareAmounts(amount, "0") !== 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([assetCode, amount]) => [assetCode, normalize(amount)] as const);
    if (nonZero.length > 0) {
      items.push({ userId, balances: Object.fromEntries(nonZero) });
    }
  }

  return { generatedAt: params.generatedAt, items };
}
