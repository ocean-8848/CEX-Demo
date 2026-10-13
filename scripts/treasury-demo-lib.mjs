// Demo helpers for the custody layering / proof-of-reserves module of
// wallet-service (`/api/v1/wallet/treasury/*`).
//
// The demo ledger seeds users and market makers from an opening-balance
// (equity) account that has no coins behind it on any chain. A real exchange
// would hold those coins in its wallets, so the demo mirrors that seeding with
// "genesis" transfers: platform capital recorded as arriving in the hot / cold
// wallet. Without it the wallet-vs-ledger reconciliation would always report a
// shortfall. `DEMO_RESERVE_KEEPER_ENABLED=false` turns the keeper off so the
// shortfall can be observed.

import { fetchJson } from "./mvp-demo-lib.mjs";

const TREASURY_PATH = "/api/v1/wallet/treasury";

function floorAmount(value) {
  const floored = Math.floor(value * 1e8) / 1e8;
  return floored.toFixed(8).replace(/\.?0+$/, "");
}

export function readTreasuryDemoSettings(env = process.env) {
  return {
    keeperEnabled: env.DEMO_RESERVE_KEEPER_ENABLED !== "false",
    minRatio: Number(env.DEMO_RESERVE_MIN_RATIO ?? "1.05"),
    targetRatio: Number(env.DEMO_RESERVE_TARGET_RATIO ?? "1.2")
  };
}

export async function getTreasuryOverview(config) {
  return fetchJson(`${config.walletBaseUrl}${TREASURY_PATH}/overview`);
}

export async function getTreasuryReconciliation(config) {
  return fetchJson(`${config.walletBaseUrl}${TREASURY_PATH}/reconciliation`);
}

async function recordGenesis(config, { assetCode, network, walletType, amount, reference, note }) {
  return fetchJson(`${config.walletBaseUrl}${TREASURY_PATH}/genesis`, {
    method: "POST",
    body: JSON.stringify({ assetCode, network, walletType, amount, reference, note, requestedBy: "demo-scripts" })
  });
}

/**
 * Funds the treasury so every asset is covered:
 * - `fundHot`: a hot wallet below its lower watermark is filled to the target
 *   (bootstrap only; afterwards the hot wallet is refilled through approved
 *   cold -> hot transfers)
 * - reserves below `minRatio` x net liabilities are topped up to
 *   `targetRatio` x net liabilities in the cold wallet
 */
export async function ensureTreasuryReserves(
  config,
  { fundHot = false, minRatio = 1.05, targetRatio = 1.2, referencePrefix = "demo_reserve" } = {}
) {
  const [overview, reconciliation] = await Promise.all([
    getTreasuryOverview(config),
    getTreasuryReconciliation(config)
  ]);
  const funded = [];
  const stamp = Date.now();

  for (const holding of overview.holdings ?? []) {
    const item = (reconciliation.items ?? []).find((entry) => entry.assetCode === holding.assetCode);
    let reserves = Number(item?.reserves ?? holding.total ?? 0);
    const netLiabilities = Number(item?.netLiabilities ?? 0);

    if (fundHot && holding.watermark && Number(holding.hot) < Number(holding.watermark.low)) {
      const amount = floorAmount(Number(holding.watermark.target) - Number(holding.hot));
      if (Number(amount) > 0) {
        await recordGenesis(config, {
          assetCode: holding.assetCode,
          network: holding.network,
          walletType: "hot",
          amount,
          reference: `${referencePrefix}:${holding.assetCode}:hot:${stamp}`,
          note: "演示注资：热钱包初始资金（水位目标）"
        });
        reserves += Number(amount);
        funded.push({ assetCode: holding.assetCode, walletType: "hot", amount });
      }
    }

    if (netLiabilities > 0 && reserves < netLiabilities * minRatio) {
      const amount = floorAmount(netLiabilities * targetRatio - reserves);
      if (Number(amount) > 0) {
        await recordGenesis(config, {
          assetCode: holding.assetCode,
          network: holding.network,
          walletType: "cold",
          amount,
          reference: `${referencePrefix}:${holding.assetCode}:cold:${stamp}`,
          note: `演示注资：把储备率补到 ${Math.round(targetRatio * 100)}%（对应期初权益发放给用户的余额）`
        });
        funded.push({ assetCode: holding.assetCode, walletType: "cold", amount });
      }
    }
  }

  return { funded };
}

/** One round of the treasury jobs a real exchange runs on a schedule. */
export async function runTreasuryJobs(config, settings = readTreasuryDemoSettings()) {
  const sweep = await fetchJson(`${config.walletBaseUrl}${TREASURY_PATH}/sweeps/run`, {
    method: "POST",
    body: JSON.stringify({ requestedBy: "demo-simulator" })
  });
  const watermarks = await fetchJson(`${config.walletBaseUrl}${TREASURY_PATH}/watermarks/evaluate`, {
    method: "POST",
    body: JSON.stringify({ requestedBy: "demo-simulator" })
  });
  const keeper = settings.keeperEnabled
    ? await ensureTreasuryReserves(config, {
        minRatio: settings.minRatio,
        targetRatio: settings.targetRatio,
        referencePrefix: "demo_reserve_keeper"
      })
    : { funded: [] };
  return {
    sweptCount: sweep.broadcastedCount ?? 0,
    sweepFailedCount: sweep.failedCount ?? 0,
    proposedCount: (watermarks.created ?? []).length,
    fundedCount: keeper.funded.length
  };
}
