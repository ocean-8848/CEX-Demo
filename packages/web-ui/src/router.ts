import { useEffect, useState } from "react";

// Minimal hash router: `#/trade/ETH-USDT?x=1` -> { path: ["trade", "ETH-USDT"], query }.
// Hash routing keeps the static web hosts trivial (no server-side rewrites).

export interface HashRoute {
  segments: string[];
  query: URLSearchParams;
}

export function parseHashRoute(hash: string): HashRoute {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", search = ""] = raw.split("?");
  return {
    segments: path.split("/").filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(search)
  };
}

export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHashRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function href(path: string): string {
  return `#${path.startsWith("/") ? path : `/${path}`}`;
}

export function navigate(path: string): void {
  const next = href(path);
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}
