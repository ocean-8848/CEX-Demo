import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SPOT_MARKET,
  listAssetDefinitions,
  listSpotMarketDefinitions,
  type Network,
  type SpotMarketDefinition
} from "@web3-cex/domain";

/** Asset metadata the browser needs; derived from config/markets.json. */
export interface TraderWebAssetConfig {
  code: string;
  name: string;
  decimals: number;
  displayDecimals: number;
  networks: Network[];
  withdrawalFee: string;
  /** Present only when the demo faucet supports the asset. */
  faucet?: {
    maxAmount: string;
    presets: string[];
  };
}

import {
  buildSessionCookies,
  clearSessionCookies,
  csrfSatisfied,
  hasBearer,
  readSessionToken
} from "./session.js";

export interface TraderWebDemoConfig {
  /** When true the UI shows the faucet, one-click demo login and simulator status. */
  enabled: boolean;
  simulatorBaseUrl: string;
  /** Seeded demo account offered for one-click login (learning demo only). */
  account?: {
    email: string;
    password: string;
  };
}

export interface TraderWebRuntimeConfig {
  appTitle: string;
  gatewayBaseUrl: string;
  marketDataBaseUrl: string;
  gatewayWsUrl: string;
  marketDataWsUrl: string;
  gatewayHttpBasePath: string;
  marketDataHttpBasePath: string;
  demoHttpBasePath: string;
  /** Tradable (non-delisted) markets from config/markets.json, in config order. */
  markets: SpotMarketDefinition[];
  defaultMarket: string;
  assets: TraderWebAssetConfig[];
  demo: TraderWebDemoConfig;
  /** Jaeger UI base URL when tracing is on; the learning drawer links traces there. */
  tracingUiUrl?: string;
  /** Same-origin path of the private WebSocket proxy (session cookie attached server-side). */
  privateWsPath: string;
  /** Mark session cookies Secure (set behind HTTPS). */
  cookieSecure: boolean;
  /** ops-console URL, linked from guided scenarios that need an operator step. */
  opsConsoleUrl: string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PUBLIC_DIR = path.resolve(currentDir, "../public");
const DEFAULT_GATEWAY_HTTP_BASE_PATH = "/api/gateway";
const DEFAULT_MARKET_HTTP_BASE_PATH = "/api/market";
const DEFAULT_DEMO_HTTP_BASE_PATH = "/api/demo";
const DEFAULT_PRIVATE_WS_PATH = "/api/realtime";
const GATEWAY_PREFIX = "/api/v1/gateway";
// Only these simulator routes are reachable from the browser; maker controls stay local.
const DEMO_PROXY_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/status$/ },
  { method: "POST", pattern: /^\/faucet$/ },
  { method: "GET", pattern: /^\/faucet\/[\w-]+$/ }
];

export function buildRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): TraderWebRuntimeConfig {
  const gatewayBaseUrl = normalizeBaseUrl(
    env.TRADER_WEB_GATEWAY_URL ?? "http://127.0.0.1:3007"
  );
  const marketDataBaseUrl = normalizeBaseUrl(
    env.TRADER_WEB_MARKET_DATA_URL ?? "http://127.0.0.1:3012"
  );

  return {
    appTitle: env.TRADER_WEB_TITLE?.trim() || "Web3 CEX Trader",
    gatewayBaseUrl,
    marketDataBaseUrl,
    gatewayWsUrl:
      env.TRADER_WEB_GATEWAY_WS_URL?.trim() ||
      `${toWebSocketBase(gatewayBaseUrl)}/api/v1/gateway/realtime`,
    marketDataWsUrl:
      env.TRADER_WEB_MARKET_DATA_WS_URL?.trim() ||
      `${toWebSocketBase(marketDataBaseUrl)}/api/v1/market-data/ws`,
    gatewayHttpBasePath: DEFAULT_GATEWAY_HTTP_BASE_PATH,
    marketDataHttpBasePath: DEFAULT_MARKET_HTTP_BASE_PATH,
    demoHttpBasePath: DEFAULT_DEMO_HTTP_BASE_PATH,
    markets: listSpotMarketDefinitions(),
    defaultMarket: DEFAULT_SPOT_MARKET,
    assets: buildAssetConfig(),
    demo: buildDemoConfig(env),
    tracingUiUrl:
      env.TRADER_WEB_TRACING_UI_URL?.trim() ||
      (env.OTEL_ENABLED === "true" ? "http://127.0.0.1:16686" : undefined),
    privateWsPath: DEFAULT_PRIVATE_WS_PATH,
    cookieSecure: env.TRADER_WEB_COOKIE_SECURE === "true",
    opsConsoleUrl: normalizeBaseUrl(env.TRADER_WEB_OPS_CONSOLE_URL ?? "http://127.0.0.1:3006")
  };
}

export function buildAssetConfig(): TraderWebAssetConfig[] {
  return listAssetDefinitions().map((asset) => {
    const maxAmount = asset.demo?.faucetMaxAmount;
    return {
      code: asset.code,
      name: asset.name,
      decimals: asset.decimals,
      displayDecimals: asset.displayDecimals,
      networks: [...asset.networks],
      withdrawalFee: asset.withdrawalFee,
      ...(maxAmount ? { faucet: { maxAmount, presets: asset.demo?.faucetPresets ?? [maxAmount] } } : {})
    };
  });
}

function buildDemoConfig(env: NodeJS.ProcessEnv): TraderWebDemoConfig {
  const enabled = (env.TRADER_WEB_DEMO_MODE ?? "true") !== "false";
  const email = env.TRADER_WEB_DEMO_EMAIL ?? "demo-trader@example.com";
  const password = env.TRADER_WEB_DEMO_PASSWORD ?? "DemoTraderPass123!";
  return {
    enabled,
    simulatorBaseUrl: normalizeBaseUrl(
      env.TRADER_WEB_DEMO_SIMULATOR_URL ?? "http://127.0.0.1:3014"
    ),
    account: enabled && email && password ? { email, password } : undefined
  };
}

export function createTraderWebServer(
  config: TraderWebRuntimeConfig = buildRuntimeConfig(),
  publicDir = DEFAULT_PUBLIC_DIR
): Server {
  const server = createServer((request, response) => {
    void handleRequest(request, response, config, publicDir).catch((error) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          code: "TRADER_WEB_INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "unknown trader-web error"
        })
      );
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    proxyPrivateWebSocket(request, socket, head, config);
  });
  return server;
}

/**
 * Pipes the browser's private WebSocket to the gateway, adding
 * `Authorization: Bearer <cookie token>` to the upgrade request. The browser
 * keeps its Origin header, so the gateway's Origin check still applies.
 */
function proxyPrivateWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: TraderWebRuntimeConfig
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== config.privateWsPath) {
    socket.destroy();
    return;
  }
  const token = readSessionToken(request.headers);
  if (!token) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }

  const upstreamUrl = new URL(config.gatewayWsUrl.replace(/^ws/, "http"));
  const upstream = connectTcp(Number(upstreamUrl.port || 80), upstreamUrl.hostname, () => {
    const lines = [`GET ${upstreamUrl.pathname} HTTP/1.1`, `Host: ${upstreamUrl.host}`];
    for (const [key, value] of Object.entries(request.headers)) {
      if (!value || ["host", "cookie", "authorization"].includes(key)) {
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        lines.push(`${key}: ${item}`);
      }
    }
    lines.push(`Authorization: Bearer ${token}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", destroyBoth);
  socket.on("error", destroyBoth);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: TraderWebRuntimeConfig,
  publicDir: string
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/healthz") {
    return writeJson(response, 200, {
      status: "ok",
      service: "trader-web",
      appTitle: config.appTitle
    });
  }

  if (url.pathname === "/api/config") {
    return writeJson(response, 200, config);
  }

  if (url.pathname.startsWith("/api/session")) {
    return handleSession(request, response, url.pathname, config);
  }

  if (url.pathname.startsWith(config.demoHttpBasePath)) {
    const suffix = url.pathname.slice(config.demoHttpBasePath.length);
    const method = (request.method ?? "GET").toUpperCase();
    const allowed = DEMO_PROXY_ROUTES.some(
      (route) => route.method === method && route.pattern.test(suffix)
    );
    if (!config.demo.enabled || !allowed) {
      return writeJson(response, 404, {
        code: "DEMO_ROUTE_NOT_FOUND",
        message: "Demo route is disabled or not exposed"
      });
    }
    if (!authorizeCookieWrite(request, response)) {
      return;
    }
    try {
      await proxyRequest(
        request,
        response,
        config.demo.simulatorBaseUrl,
        "/api/demo",
        config.demoHttpBasePath
      );
    } catch {
      writeJson(response, 503, {
        code: "DEMO_SIMULATOR_UNAVAILABLE",
        message: "demo-simulator is not running (start it with `pnpm demo:simulator`)"
      });
    }
    return;
  }

  if (url.pathname.startsWith(config.gatewayHttpBasePath)) {
    if (!authorizeCookieWrite(request, response)) {
      return;
    }
    await proxyRequest(
      request,
      response,
      config.gatewayBaseUrl,
      GATEWAY_PREFIX,
      config.gatewayHttpBasePath
    );
    return;
  }

  if (url.pathname.startsWith(config.marketDataHttpBasePath)) {
    await proxyRequest(
      request,
      response,
      config.marketDataBaseUrl,
      "/api/v1/market-data",
      config.marketDataHttpBasePath
    );
    return;
  }

  if ((request.method ?? "GET") !== "GET" && (request.method ?? "GET") !== "HEAD") {
    writeJson(response, 405, {
      code: "METHOD_NOT_ALLOWED",
      message: "Only GET and HEAD are allowed for static routes"
    });
    return;
  }

  await serveStaticAsset(response, publicDir, url.pathname);
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamBaseUrl: string,
  upstreamPrefix: string,
  proxyPrefix: string
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const suffix = requestUrl.pathname.slice(proxyPrefix.length);
  const upstreamUrl = new URL(`${upstreamPrefix}${suffix}${requestUrl.search}`, upstreamBaseUrl);
  const method = (request.method ?? "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (!value) {
      continue;
    }
    // Cookies stay at the Web Host; upstreams only ever see a bearer token.
    if (["host", "connection", "content-length", "cookie", "x-csrf-token"].includes(key.toLowerCase())) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const cookieToken = readSessionToken(request.headers);
  if (cookieToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${cookieToken}`);
  }

  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined
  });

  response.statusCode = upstream.status;
  response.setHeader(
    "content-type",
    upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
  );
  response.setHeader("cache-control", "no-store");
  const traceId = upstream.headers.get("x-trace-id");
  if (traceId) {
    response.setHeader("x-trace-id", traceId);
  }

  const payload = Buffer.from(await upstream.arrayBuffer());
  response.end(payload);
}

/** A cookie-authenticated write must carry the CSRF header (explicit bearer callers are exempt). */
function authorizeCookieWrite(request: IncomingMessage, response: ServerResponse): boolean {
  if (!readSessionToken(request.headers) || hasBearer(request.headers)) {
    return true;
  }
  if (csrfSatisfied(request.method ?? "GET", request.headers)) {
    return true;
  }
  writeJson(response, 403, { code: "CSRF_TOKEN_INVALID", message: "Missing or invalid CSRF token" });
  return false;
}

/**
 * POST /api/session          log in (gateway /auth/sessions) and set the cookies
 * GET  /api/session          current session from the cookie
 * POST /api/session/logout   revoke at the gateway and clear the cookies
 */
async function handleSession(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  config: TraderWebRuntimeConfig
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const token = readSessionToken(request.headers);

  if (pathname === "/api/session" && method === "POST") {
    const body = await readBody(request);
    const upstream = await fetch(`${config.gatewayBaseUrl}${GATEWAY_PREFIX}/auth/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": String(request.headers["user-agent"] ?? "trader-web")
      },
      body: body ? new Uint8Array(body) : "{}"
    });
    const payload = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok || typeof payload.token !== "string") {
      return writeJson(response, upstream.ok ? 502 : upstream.status, payload);
    }
    const { token: sessionToken, ...session } = payload;
    response.setHeader(
      "set-cookie",
      buildSessionCookies(sessionToken as string, session.expiresAt as string | undefined, config.cookieSecure)
    );
    return writeJson(response, 201, session);
  }

  if (pathname === "/api/session" && method === "GET") {
    if (!token) {
      return writeJson(response, 401, { code: "NO_SESSION", message: "Not signed in" });
    }
    const upstream = await fetch(`${config.gatewayBaseUrl}${GATEWAY_PREFIX}/auth/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const payload = await upstream.json().catch(() => ({}));
    if (upstream.status === 401) {
      response.setHeader("set-cookie", clearSessionCookies(config.cookieSecure));
    }
    return writeJson(response, upstream.status, payload);
  }

  if (pathname === "/api/session/logout" && method === "POST") {
    if (!authorizeCookieWrite(request, response)) {
      return;
    }
    if (token) {
      await fetch(`${config.gatewayBaseUrl}${GATEWAY_PREFIX}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}"
      }).catch(() => undefined);
    }
    response.setHeader("set-cookie", clearSessionCookies(config.cookieSecure));
    return writeJson(response, 200, { revoked: Boolean(token) });
  }

  return writeJson(response, 404, { code: "NOT_FOUND", message: "Unknown session route" });
}

async function serveStaticAsset(
  response: ServerResponse,
  publicDir: string,
  pathname: string
): Promise<void> {
  const candidate = resolvePublicFile(publicDir, pathname);
  const indexFile = path.join(publicDir, "index.html");

  if (!candidate) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  try {
    const file = await readFile(candidate);
    response.statusCode = 200;
    response.setHeader("content-type", readContentType(candidate));
    response.end(file);
    return;
  } catch (error) {
    if (!pathname.includes(".")) {
      const file = await readFile(indexFile);
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(file);
      return;
    }

    response.statusCode = 404;
    response.end(error instanceof Error ? error.message : "Not found");
  }
}

function resolvePublicFile(publicDir: string, pathname: string): string | null {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const normalized = path
    .normalize(safePath)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, normalized);
  return resolved.startsWith(path.resolve(publicDir)) ? resolved : null;
}

function readContentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "text/html; charset=utf-8";
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return Buffer.concat(chunks);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function toWebSocketBase(value: string): string {
  if (value.startsWith("https://")) {
    return `wss://${value.slice("https://".length)}`;
  }
  if (value.startsWith("http://")) {
    return `ws://${value.slice("http://".length)}`;
  }
  return value;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}
