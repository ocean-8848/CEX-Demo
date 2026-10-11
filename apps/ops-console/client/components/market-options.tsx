import { useMarketConfig } from "../state/hooks.js";

/** `<option>`s for every asset in config/markets.json. */
export function AssetOptions() {
  const { assets } = useMarketConfig();
  return (
    <>
      {assets.map((asset) => (
        <option key={asset.code} value={asset.code}>
          {asset.code}
        </option>
      ))}
    </>
  );
}

/** `<option>`s for every market in config/markets.json (delisted ones marked). */
export function MarketOptions() {
  const { markets } = useMarketConfig();
  return (
    <>
      {markets.map((item) => (
        <option key={item.market} value={item.market}>
          {item.market.replace("-", "/")}
          {item.configuredStatus === "delisted" ? "（已下架）" : ""}
        </option>
      ))}
    </>
  );
}
