// HTTP client for the ops-console BFF (`/api/v1/ops/*`, same origin).

export const OPS_API_BASE = "/api/v1/ops";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

export type OpsFetch = <T>(path: string, options?: RequestOptions) => Promise<T>;

/**
 * The session token lives in an HttpOnly cookie set by the BFF, so
 * this code never sees it. Writes echo the readable `ops_csrf` cookie in the
 * `x-csrf-token` header (double-submit CSRF protection).
 */
export function readCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)ops_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

export function createOpsFetch(isSignedIn: () => boolean, onUnauthorized: () => void): OpsFetch {
  return async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
    const headers = new Headers({ accept: "application/json", "x-ops-session-mode": "cookie" });
    const method = options.method ?? "GET";
    if (method !== "GET") {
      headers.set("x-csrf-token", readCsrfToken());
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetch(`${OPS_API_BASE}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch {
      throw new ApiError("网络不可用，请确认 ops-console 服务已启动", 0);
    }

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
      if (response.status === 401 && isSignedIn()) {
        onUnauthorized();
      }
      const record = (payload && typeof payload === "object" ? payload : {}) as { message?: unknown };
      const message = Array.isArray(record.message)
        ? record.message.join("; ")
        : typeof record.message === "string"
          ? record.message
          : `HTTP ${response.status}`;
      throw new ApiError(humanize(response.status, message), response.status);
    }

    return payload as T;
  };
}

export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds `?a=1&b=2`, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** List endpoints return either a bare array or a paged envelope. */
export function itemsOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: T[] }).items;
  }
  return [];
}

export function totalOf(value: unknown): number | undefined {
  if (value && typeof value === "object" && typeof (value as { total?: unknown }).total === "number") {
    return (value as { total: number }).total;
  }
  return Array.isArray(value) ? value.length : undefined;
}

function humanize(status: number, message: string): string {
  if (status === 403) {
    return `权限不足（${message}）`;
  }
  if (status === 401) {
    return `登录已失效（${message}）`;
  }
  if (/two.?factor|totp/i.test(message)) {
    return `二次验证码无效或已使用（${message}）`;
  }
  return message;
}
