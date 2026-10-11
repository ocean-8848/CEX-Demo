import { useCallback, useEffect, useRef, useState } from "react";

import { readErrorMessage } from "../lib/api.js";
import type { MarketConfig } from "../lib/types.js";
import { useSession } from "./session.js";

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  updatedAt: number | null;
}

/**
 * GETs `path` (relative to /api/v1/ops) and re-fetches when it changes.
 * `null` skips the request. `refreshMs` polls in the background.
 */
export function useOpsQuery<T>(path: string | null, options: { refreshMs?: number } = {}): QueryState<T> {
  const { api } = useSession();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const run = async (background: boolean) => {
      const requestId = ++requestRef.current;
      if (!background) {
        setLoading(true);
      }
      try {
        const result = await api<T>(path);
        if (!cancelled && requestId === requestRef.current) {
          setData(result);
          setError(null);
          setUpdatedAt(Date.now());
        }
      } catch (queryError) {
        if (!cancelled && requestId === requestRef.current) {
          setError(readErrorMessage(queryError));
        }
      } finally {
        if (!cancelled && requestId === requestRef.current) {
          setLoading(false);
        }
      }
    };
    void run(false);
    const timer = options.refreshMs ? window.setInterval(() => void run(true), options.refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, [api, path, nonce, options.refreshMs]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload, updatedAt };
}

/**
 * Wraps a mutation: tracks a busy key, shows a success / failure toast and
 * returns the result (or undefined on failure).
 */
export function useOpsAction() {
  const { api, toast } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(
      key: string,
      request: { path: string; body?: unknown },
      messages: { success: string; detail?: (result: T) => string | undefined }
    ): Promise<T | undefined> => {
      setBusy(key);
      try {
        const result = await api<T>(request.path, { method: "POST", body: request.body ?? {} });
        toast("positive", messages.success, messages.detail?.(result));
        return result;
      } catch (actionError) {
        toast("negative", "操作失败", readErrorMessage(actionError));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [api, toast]
  );

  return { busy, run };
}

const EMPTY_MARKET_CONFIG: MarketConfig = { defaultMarket: "", markets: [], assets: [] };

/**
 * Markets / assets from config/markets.json (via the BFF), for dropdowns.
 * Pages never hard-code market or asset lists.
 */
export function useMarketConfig(): MarketConfig & { loaded: boolean } {
  const query = useOpsQuery<MarketConfig>("/market-config");
  return { ...(query.data ?? EMPTY_MARKET_CONFIG), loaded: Boolean(query.data) };
}
