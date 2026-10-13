import { useEffect, useState } from "react";

import { createApiClient } from "../lib/api.js";
import { useExchange } from "./store.js";

/** Public platform status from api-gateway `GET /system/controls` (emergency switches). */
export interface SystemControls {
  withdrawalsPaused: boolean;
  pausedWithdrawalAssets: string[];
  apiWriteFrozen: boolean;
}

const POLL_MS = 15_000;

/**
 * Polls the emergency switches so forms can explain a pause up front.
 * The gateway still enforces them (409 WITHDRAWALS_PAUSED /
 * ASSET_WITHDRAWALS_PAUSED / API_WRITE_FROZEN); this is only the banner.
 */
export function useSystemControls(): SystemControls | null {
  const { state } = useExchange();
  const [controls, setControls] = useState<SystemControls | null>(null);
  const config = state.config;

  useEffect(() => {
    if (!config) {
      return;
    }
    const client = createApiClient(config);
    let cancelled = false;
    const load = async () => {
      try {
        const result = await client.gateway<SystemControls>("/system/controls");
        if (!cancelled) {
          setControls({
            withdrawalsPaused: Boolean(result.withdrawalsPaused),
            pausedWithdrawalAssets: Array.isArray(result.pausedWithdrawalAssets) ? result.pausedWithdrawalAssets : [],
            apiWriteFrozen: Boolean(result.apiWriteFrozen)
          });
        }
      } catch {
        // Keep the last known state; the gateway enforces the switches anyway.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [config]);

  return controls;
}

export function isWithdrawalPaused(controls: SystemControls | null, assetCode: string): boolean {
  return Boolean(controls && (controls.withdrawalsPaused || controls.pausedWithdrawalAssets.includes(assetCode)));
}
