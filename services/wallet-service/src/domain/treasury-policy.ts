import {
  addAmounts,
  compareAmounts,
  divideAmounts,
  floorAmountToStep,
  fromAtomicUnits,
  subtractAmounts,
  toAtomicUnits
} from "@web3-cex/domain";
import type { AssetCode, Network } from "@web3-cex/domain";

import type {
  AssetNetworkAmount,
  HotWalletWatermark,
  ReserveReconciliationItem,
  ReserveReconciliationReport,
  SentWithdrawalTotal,
  TreasuryAssetHoldings,
  TreasuryTransferTotal,
  UnsweptDeposit,
  WatermarkEvaluation
} from "./treasury-types.js";

// Pure treasury rules: holdings derivation, sweep planning, hot-wallet
// watermarks and wallet-vs-ledger reconciliation. No I/O, unit-tested in
// src/__tests__/treasury-policy.test.ts.

/** Amounts the treasury proposes are floored to 8 decimals. */
export const TREASURY_AMOUNT_STEP = "0.00000001";

/** Learning-demo defaults (low / high per asset); `TREASURY_HOT_WALLET_WATERMARKS` overrides. */
export const DEFAULT_HOT_WALLET_WATERMARKS = "USDT=50000/200000,USDC=10000/50000,ETH=10/40,BTC=0.5/2,SOL=200/800";

function normalize(amount: string): string {
  return fromAtomicUnits(toAtomicUnits(amount));
}

function isPositive(amount: string): boolean {
  return compareAmounts(amount, "0") > 0;
}

/**
 * Parses `ASSET=low/high,...`. Entries with a non-positive low or low >= high
 * are rejected so a typo cannot make the evaluator ping-pong funds.
 */
export function parseHotWalletWatermarks(raw: string | undefined): Record<AssetCode, HotWalletWatermark> {
  const result: Record<AssetCode, HotWalletWatermark> = {};
  for (const entry of (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*([0-9.]+)\s*\/\s*([0-9.]+)$/.exec(entry);
    if (!match) {
      throw new Error(`Invalid hot wallet watermark "${entry}" (expected ASSET=low/high)`);
    }
    const [, asset = "", low = "0", high = "0"] = match;
    if (!isPositive(low) || compareAmounts(low, high) >= 0) {
      throw new Error(`Invalid hot wallet watermark "${entry}": need 0 < low < high`);
    }
    result[asset.toUpperCase()] = {
      low: normalize(low),
      high: normalize(high),
      target: floorAmountToStep(divideAmounts(addAmounts(low, high), "2"), TREASURY_AMOUNT_STEP)
    };
  }
  return result;
}

/** Parses `ASSET=amount,...` (e.g. minimum sweep amounts). */
export function parseAssetAmountMap(raw: string | undefined): Record<AssetCode, string> {
  const result: Record<AssetCode, string> = {};
  for (const entry of (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const [asset, amount] = entry.split("=").map((part) => part.trim());
    if (!asset || !amount || !/^\d+(\.\d+)?$/.test(amount)) {
      throw new Error(`Invalid asset amount "${entry}" (expected ASSET=amount)`);
    }
    result[asset.toUpperCase()] = normalize(amount);
  }
  return result;
}

const LIVE_OUT = new Set(["broadcasted", "confirmed"]);

/**
 * Derives on-chain holdings per (asset, network) from three fact sources:
 *
 * - credited deposits                      -> + deposit addresses
 * - treasury transfers                     -> from wallet leaves when broadcast,
 *                                             to wallet receives when confirmed
 *                                             (the gap is "internal in transit")
 * - withdrawals broadcast / confirmed      -> - hot wallet (paid on chain)
 *
 * The withdrawal fee is not paid on chain: it stays in the hot wallet and
 * becomes platform equity once the ledger consumes the lock.
 */
export function computeTreasuryHoldings(input: {
  creditedDeposits: AssetNetworkAmount[];
  sentWithdrawals: SentWithdrawalTotal[];
  transferTotals: TreasuryTransferTotal[];
  /** Assets that must appear even without any activity. */
  assets?: Array<{ assetCode: AssetCode; network: Network }>;
}): TreasuryAssetHoldings[] {
  const rows = new Map<string, TreasuryAssetHoldings>();
  const row = (assetCode: AssetCode, network: Network): TreasuryAssetHoldings => {
    const key = `${assetCode}:${network}`;
    let current = rows.get(key);
    if (!current) {
      current = {
        assetCode,
        network,
        depositAddresses: "0",
        hot: "0",
        cold: "0",
        internalInTransit: "0",
        total: "0",
        withdrawalsInFlight: "0",
        withdrawalsInFlightCount: 0,
        genesis: "0"
      };
      rows.set(key, current);
    }
    return current;
  };
  const adjust = (target: TreasuryAssetHoldings, wallet: string, delta: string) => {
    if (wallet === "deposit") {
      target.depositAddresses = addAmounts(target.depositAddresses, delta);
    } else if (wallet === "hot") {
      target.hot = addAmounts(target.hot, delta);
    } else if (wallet === "cold") {
      target.cold = addAmounts(target.cold, delta);
    }
  };

  for (const asset of input.assets ?? []) {
    row(asset.assetCode, asset.network);
  }

  for (const deposit of input.creditedDeposits) {
    adjust(row(deposit.assetCode, deposit.network), "deposit", deposit.amount);
  }

  for (const total of input.transferTotals) {
    const target = row(total.assetCode, total.network);
    if (LIVE_OUT.has(total.status) && total.fromWallet !== "external") {
      adjust(target, total.fromWallet, subtractAmounts("0", total.amount));
    }
    if (total.status === "broadcasted") {
      target.internalInTransit = addAmounts(target.internalInTransit, total.amount);
    }
    if (total.status === "confirmed") {
      adjust(target, total.toWallet, total.amount);
      if (total.kind === "genesis") {
        target.genesis = addAmounts(target.genesis, total.amount);
      }
    }
  }

  for (const withdrawal of input.sentWithdrawals) {
    const target = row(withdrawal.assetCode, withdrawal.network);
    adjust(target, "hot", subtractAmounts("0", withdrawal.amount));
    if (withdrawal.status === "broadcasted") {
      target.withdrawalsInFlight = addAmounts(target.withdrawalsInFlight, withdrawal.amount);
      target.withdrawalsInFlightCount += withdrawal.count;
    }
  }

  return [...rows.values()]
    .map((item) => {
      const normalized = {
        ...item,
        depositAddresses: normalize(item.depositAddresses),
        hot: normalize(item.hot),
        cold: normalize(item.cold),
        internalInTransit: normalize(item.internalInTransit),
        withdrawalsInFlight: normalize(item.withdrawalsInFlight),
        genesis: normalize(item.genesis)
      };
      normalized.total = normalize(
        [normalized.depositAddresses, normalized.hot, normalized.cold, normalized.internalInTransit].reduce(addAmounts, "0")
      );
      return normalized;
    })
    .sort((left, right) => left.assetCode.localeCompare(right.assetCode) || left.network.localeCompare(right.network));
}

export interface SweepPlan {
  assetCode: AssetCode;
  network: Network;
  fromAddress: string;
  amount: string;
  depositIds: string[];
}

/**
 * One sweep per deposit address and asset (on chain every address signs its
 * own transfer). Groups below the asset's minimum stay where they are - in
 * reality sweeping dust costs more gas than it is worth.
 */
export function planSweeps(deposits: UnsweptDeposit[], minAmounts: Record<AssetCode, string> = {}): SweepPlan[] {
  const groups = new Map<string, SweepPlan>();
  for (const deposit of deposits) {
    const key = `${deposit.network}:${deposit.assetCode}:${deposit.address}`;
    const group = groups.get(key) ?? {
      assetCode: deposit.assetCode,
      network: deposit.network,
      fromAddress: deposit.address,
      amount: "0",
      depositIds: []
    };
    group.amount = addAmounts(group.amount, deposit.amount);
    group.depositIds.push(deposit.depositId);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, amount: normalize(group.amount), depositIds: [...group.depositIds].sort() }))
    .filter((group) => isPositive(group.amount))
    .filter((group) => compareAmounts(group.amount, minAmounts[group.assetCode] ?? "0") >= 0)
    .sort(
      (left, right) =>
        left.network.localeCompare(right.network) ||
        left.assetCode.localeCompare(right.assetCode) ||
        left.fromAddress.localeCompare(right.fromAddress)
    );
}

/**
 * Hot wallet watermark rule:
 *
 * - hot > high  -> propose hot -> cold of (hot - target)
 * - hot < low   -> propose cold -> hot of min(target - hot, cold)
 * - otherwise   -> nothing
 *
 * At most one open rebalance per asset: while one is proposed / approved /
 * broadcasting the evaluator only reports the state.
 */
export function evaluateHotWalletWatermark(input: {
  holdings: Pick<TreasuryAssetHoldings, "assetCode" | "network" | "hot" | "cold">;
  watermark?: HotWalletWatermark;
  hasOpenRebalance: boolean;
}): WatermarkEvaluation {
  const { holdings, watermark } = input;
  const base = {
    assetCode: holdings.assetCode,
    network: holdings.network,
    hot: holdings.hot,
    cold: holdings.cold,
    watermark
  };
  if (!watermark) {
    return { ...base, state: "unconfigured" };
  }

  if (compareAmounts(holdings.hot, watermark.high) > 0) {
    const amount = floorAmountToStep(subtractAmounts(holdings.hot, watermark.target), TREASURY_AMOUNT_STEP);
    if (input.hasOpenRebalance) {
      return { ...base, state: "above_high", skippedReason: "已有未完成的调拨单" };
    }
    return {
      ...base,
      state: "above_high",
      proposal: {
        kind: "rebalance_to_cold",
        amount,
        reason: `热钱包 ${holdings.hot} 高于上限 ${watermark.high}，转出 ${amount} 到冷钱包，回到目标 ${watermark.target}`
      }
    };
  }

  if (compareAmounts(holdings.hot, watermark.low) < 0) {
    if (input.hasOpenRebalance) {
      return { ...base, state: "below_low", skippedReason: "已有未完成的调拨单" };
    }
    const wanted = subtractAmounts(watermark.target, holdings.hot);
    const capped = compareAmounts(wanted, holdings.cold) > 0 ? holdings.cold : wanted;
    const amount = floorAmountToStep(capped, TREASURY_AMOUNT_STEP);
    if (!isPositive(amount)) {
      return { ...base, state: "below_low", skippedReason: "冷钱包余额不足，无法补充" };
    }
    return {
      ...base,
      state: "below_low",
      proposal: {
        kind: "rebalance_to_hot",
        amount,
        reason: `热钱包 ${holdings.hot} 低于下限 ${watermark.low}，从冷钱包补充 ${amount}，回到目标 ${watermark.target}`
      }
    };
  }

  return { ...base, state: "within" };
}

/** numerator / denominator floored to 4 decimals; undefined when the denominator is not positive. */
export function formatRatio(numerator: string, denominator: string): string | undefined {
  if (!isPositive(denominator)) {
    return undefined;
  }
  const ratio = floorAmountToStep(divideAmounts(numerator, denominator), "0.0001");
  const [whole = "0", fraction = ""] = ratio.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

/**
 * Wallet-vs-ledger reconciliation per asset:
 *
 *   reserves        = deposit addresses + hot + cold + internal in transit   (on chain)
 *   netLiabilities  = ledger user liabilities - withdrawals in flight        (ledger)
 *   status          = covered when reserves >= netLiabilities
 *
 * Withdrawals in flight have already left the hot wallet but their ledger
 * lock is only consumed at the confirmation threshold, so they are taken out
 * of the liability side to compare like with like. This is a coverage check,
 * not an equality: the surplus is platform equity held on chain (genesis
 * capital, withdrawal fees kept in the hot wallet, trading fees).
 */
export function buildReserveReconciliation(input: {
  generatedAt: string;
  holdings: TreasuryAssetHoldings[];
  liabilities: Array<{ assetCode: AssetCode; total: string }>;
}): ReserveReconciliationReport {
  const assets = new Map<AssetCode, ReserveReconciliationItem>();
  const item = (assetCode: AssetCode): ReserveReconciliationItem => {
    let current = assets.get(assetCode);
    if (!current) {
      current = {
        assetCode,
        networks: [],
        depositAddresses: "0",
        hot: "0",
        cold: "0",
        internalInTransit: "0",
        reserves: "0",
        ledgerLiabilities: "0",
        withdrawalsInFlight: "0",
        netLiabilities: "0",
        surplus: "0",
        status: "no_liabilities"
      };
      assets.set(assetCode, current);
    }
    return current;
  };

  for (const holding of input.holdings) {
    const current = item(holding.assetCode);
    if (!current.networks.includes(holding.network)) {
      current.networks.push(holding.network);
    }
    current.depositAddresses = addAmounts(current.depositAddresses, holding.depositAddresses);
    current.hot = addAmounts(current.hot, holding.hot);
    current.cold = addAmounts(current.cold, holding.cold);
    current.internalInTransit = addAmounts(current.internalInTransit, holding.internalInTransit);
    current.reserves = addAmounts(current.reserves, holding.total);
    current.withdrawalsInFlight = addAmounts(current.withdrawalsInFlight, holding.withdrawalsInFlight);
  }
  for (const liability of input.liabilities) {
    const current = item(liability.assetCode);
    current.ledgerLiabilities = addAmounts(current.ledgerLiabilities, liability.total);
  }

  const items = [...assets.values()]
    .map((current): ReserveReconciliationItem => {
      const netLiabilities = subtractAmounts(current.ledgerLiabilities, current.withdrawalsInFlight);
      const surplus = subtractAmounts(current.reserves, netLiabilities);
      const status = !isPositive(netLiabilities)
        ? "no_liabilities"
        : compareAmounts(current.reserves, netLiabilities) >= 0
          ? "covered"
          : "shortfall";
      return {
        ...current,
        networks: [...current.networks].sort(),
        depositAddresses: normalize(current.depositAddresses),
        hot: normalize(current.hot),
        cold: normalize(current.cold),
        internalInTransit: normalize(current.internalInTransit),
        reserves: normalize(current.reserves),
        ledgerLiabilities: normalize(current.ledgerLiabilities),
        withdrawalsInFlight: normalize(current.withdrawalsInFlight),
        netLiabilities: normalize(netLiabilities),
        surplus: normalize(surplus),
        reserveRatio: formatRatio(current.reserves, netLiabilities),
        hotCoverage: formatRatio(current.hot, netLiabilities),
        status
      };
    })
    .sort((left, right) => left.assetCode.localeCompare(right.assetCode));

  const shortfallCount = items.filter((entry) => entry.status === "shortfall").length;
  return {
    generatedAt: input.generatedAt,
    status: shortfallCount > 0 ? "shortfall" : "covered",
    shortfallCount,
    items
  };
}
