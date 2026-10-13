import { useEffect, useState } from "react";

import type { FeeTierProfile } from "../lib/fee-tier.js";
import { useExchange } from "./store.js";

// One shared copy of the caller's VIP tier (A7) for the account page and the
// order form. Refetched when the user's trade count changes (volume moved) and
// at most once a minute otherwise.
let cached: { key: string; profile: FeeTierProfile | null; loadedAt: number } | null = null;
let inflight: Promise<FeeTierProfile | null> | null = null;
const listeners = new Set<(profile: FeeTierProfile | null) => void>();

export function useFeeTier(): FeeTierProfile | null {
  const { state, api } = useExchange();
  const token = state.token;
  const userId = state.session?.userId ?? "";
  const tradeCount = state.trades.length;
  const key = `${userId}:${tradeCount}`;
  const [profile, setProfile] = useState<FeeTierProfile | null>(cached?.key.startsWith(`${userId}:`) ? cached.profile : null);

  useEffect(() => {
    listeners.add(setProfile);
    return () => {
      listeners.delete(setProfile);
    };
  }, []);

  useEffect(() => {
    if (!token || !userId || !api) {
      setProfile(null);
      return;
    }
    const fresh = cached && cached.key === key && Date.now() - cached.loadedAt < 60_000;
    if (fresh) {
      setProfile(cached?.profile ?? null);
      return;
    }
    if (!inflight) {
      inflight = api
        .gateway<FeeTierProfile>("/fees/tier", { token })
        .catch(() => null)
        .then((loaded) => {
          cached = { key, profile: loaded, loadedAt: Date.now() };
          for (const listener of listeners) {
            listener(loaded);
          }
          return loaded;
        })
        .finally(() => {
          inflight = null;
        });
    }
  }, [token, userId, key, api]);

  return profile;
}
