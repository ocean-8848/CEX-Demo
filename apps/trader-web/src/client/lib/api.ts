import type { PagedResult, TraderWebRuntimeConfig } from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  /** Sent as the standard `Idempotency-Key` header; the gateway replays duplicates. */
  idempotencyKey?: string;
}

let lastTraceId: string | undefined;

/** OpenTelemetry trace id of the most recent API response (gateway `x-trace-id`). */
export function takeLastTraceId(): string | undefined {
  const traceId = lastTraceId;
  lastTraceId = undefined;
  return traceId;
}

/**
 * Marker stored in `state.token` for a browser session (M5-1). The real token
 * lives in the trader-web Web Host's HttpOnly cookie; this page never sees it
 * and the Web Host attaches it to proxied requests.
 */
export const COOKIE_SESSION = "cookie-session";

/** Double-submit CSRF token: the readable `tw_csrf` cookie echoed in a header. */
function readCsrfToken(): string {
  if (typeof document === "undefined") {
    return "";
  }
  const match = document.cookie.match(/(?:^|;\s*)tw_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

export async function fetchJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  // Explicit bearer tokens (scripts, API docs examples) still work; the cookie
  // session is attached by the Web Host instead.
  if (options.token && options.token !== COOKIE_SESSION) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if ((options.method ?? "GET") !== "GET") {
    const csrf = readCsrfToken();
    if (csrf) {
      headers.set("x-csrf-token", csrf);
    }
  }
  if (options.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch {
    throw new ApiError("网络不可用，请确认本地服务已启动", 0, "NETWORK_ERROR");
  }

  lastTraceId = response.headers.get("x-trace-id") ?? undefined;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as {
      message?: unknown;
      code?: unknown;
    };
    const message = Array.isArray(record.message)
      ? record.message.join("; ")
      : typeof record.message === "string"
        ? record.message
        : typeof payload === "string" && payload
          ? payload
          : `HTTP ${response.status}`;
    const code = typeof record.code === "string" ? record.code : undefined;
    throw new ApiError(humanizeError(message, code), response.status, code);
  }

  return payload as T;
}

export function createApiClient(config: TraderWebRuntimeConfig) {
  return {
    gateway: <T>(path: string, options?: RequestOptions) =>
      fetchJson<T>(`${config.gatewayHttpBasePath}${path}`, options),
    market: <T>(path: string) => fetchJson<T>(`${config.marketDataHttpBasePath}${path}`),
    demo: <T>(path: string, options?: RequestOptions) =>
      fetchJson<T>(`${config.demoHttpBasePath}${path}`, options)
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function fetchConfig(): Promise<TraderWebRuntimeConfig> {
  return fetchJson("/api/config");
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tw_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/** Gateway list endpoints return either a bare array or a paged envelope. */
export function itemsOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === "object" && Array.isArray((value as PagedResult<T>).items)) {
    return (value as PagedResult<T>).items;
  }
  return [];
}

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Translate the most common backend error messages into something a learner
// can act on, while keeping the original text for debugging.
const ERROR_HINTS: Array<[RegExp, string]> = [
  // M4-1 / M4-4 / M5-2 codes first: they are more specific than the generic hints below.
  [/WITHDRAWAL_2FA_NOT_ENABLED/, "请先在账户页开启二次验证"],
  [/WITHDRAWAL_2FA_REQUIRED/, "已开启二次验证，提现需要输入动态码"],
  [/TWO_FACTOR_RECOVERY_CODE_INVALID/, "恢复码无效或已被使用"],
  [/TWO_FACTOR_CODE_REUSED|already been used/, "该动态码已使用过，请等待下一个动态码"],
  [/TWO_FACTOR_INVALID_CODE|WITHDRAWAL_2FA_INVALID|code is invalid/i, "动态码错误"],
  [/TWO_FACTOR_ALREADY_ENABLED/, "二次验证已开启"],
  [/WITHDRAWAL_SINGLE_LIMIT_EXCEEDED|single-withdrawal limit/, "超出单笔提现限额（可在账户页提升 KYC 等级）"],
  [/WITHDRAWAL_DAILY_LIMIT_EXCEEDED|daily limit/, "超出今日提现额度（可在账户页提升 KYC 等级）"],
  [/KYC_REQUEST_PENDING/, "已有待审核的认证申请"],
  [/KYC_REQUEST_INVALID/, "认证信息不符合要求"],
  [/MARKET_HALTED|is halted/i, "该市场已被运营暂停交易：暂不接受新委托，已有挂单仍可撤销"],
  [/MARKET_DELISTED|is delisted/i, "该市场已下架，不再接受新委托"],
  [/INSUFFICIENT_AVAILABLE_BALANCE|below required|Insufficient/i, "可用余额不足"],
  [/price deviation/i, "委托价格偏离参考价过大（参考价为最新成交价或盘口中间价，风控限制 ±20%）"],
  [/below minimum/i, "数量低于最小下单量"],
  [/step/i, "价格或数量不符合最小变动单位"],
  [/Invalid email or password|invalid credentials/i, "邮箱或密码错误"],
  [/two.?factor/i, "需要有效的二次验证码"],
  [/whitelist/i, "提现地址未加入白名单"],
  [/Too Many Requests|rate limit/i, "请求过于频繁，请稍后再试"]
];

export function humanizeError(message: string, code?: string): string {
  const haystack = code ? `${code} ${message}` : message;
  const cooldown = describeCooldownError(haystack);
  if (cooldown) {
    return cooldown;
  }
  for (const [pattern, hint] of ERROR_HINTS) {
    if (pattern.test(haystack)) {
      return `${hint}（${message}）`;
    }
  }
  return message;
}

/**
 * M5-2: wallet-service reports `remainingSeconds=N` in WITHDRAWAL_SECURITY_COOLDOWN
 * errors; turn it into a readable countdown.
 */
export function describeCooldownError(text: string): string | null {
  if (!/WITHDRAWAL_SECURITY_COOLDOWN|Withdrawals are locked/.test(text)) {
    return null;
  }
  const remaining = Number(/remainingSeconds=(\d+)/.exec(text)?.[1] ?? NaN);
  const reason = /two-factor/i.test(text) ? "修改二次验证" : "新增提现地址";
  const wait = Number.isFinite(remaining) ? formatWait(remaining) : "一段时间";
  return `安全冷却期：${reason}后暂停提现，还需等待 ${wait}`;
}

export function formatWait(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${rest} 秒`;
  }
  return `${rest} 秒`;
}
