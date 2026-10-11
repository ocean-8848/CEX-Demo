
// App routes on top of the shared hash router:
// `#/trade/ETH-USDT` -> { page: "trade", params: ["ETH-USDT"] }.

import { href, navigate, parseHashRoute, useHashRoute } from "@web3-cex/web-ui";

export type PageKey = "home" | "trade" | "assets" | "orders" | "account" | "login";

export interface Route {
  page: PageKey;
  params: string[];
  query: URLSearchParams;
}

const PAGES: PageKey[] = ["home", "trade", "assets", "orders", "account", "login"];

export function parseHash(hash: string): Route {
  return toRoute(parseHashRoute(hash));
}

export function useRoute(): Route {
  return toRoute(useHashRoute());
}

function toRoute(route: { segments: string[]; query: URLSearchParams }): Route {
  const [head = "", ...params] = route.segments;
  const page = (PAGES as string[]).includes(head) ? (head as PageKey) : "home";
  return { page, params, query: route.query };
}

export { href, navigate };
