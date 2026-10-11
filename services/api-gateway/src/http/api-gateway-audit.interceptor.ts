import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor
} from "@nestjs/common";
import { Observable, catchError, tap, throwError } from "rxjs";

import type { GatewayPrincipal, RateLimitDecision } from "../domain/types.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";

@Injectable()
export class ApiGatewayAuditInterceptor implements NestInterceptor {
  constructor(private readonly apiGatewayHttpService: ApiGatewayHttpService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method: string;
      originalUrl: string;
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      gatewayAuth?: GatewayPrincipal;
      gatewayRateLimit?: RateLimitDecision;
    }>();
    const response = http.getResponse<{ statusCode: number }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        this.logRequest({
          request,
          response,
          durationMs: Date.now() - startedAt
        });
      }),
      catchError((error: unknown) => {
        this.logRequest({
          request,
          response,
          durationMs: Date.now() - startedAt,
          error
        });
        return throwError(() => error);
      })
    );
  }

  private logRequest(params: {
    request: {
      method: string;
      originalUrl: string;
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      gatewayAuth?: GatewayPrincipal;
      gatewayRateLimit?: RateLimitDecision;
    };
    response: { statusCode: number };
    durationMs: number;
    error?: unknown;
  }): void {
    const error = params.error as
      | {
          code?: string;
          message?: string;
          status?: number;
          getStatus?: () => number;
        }
      | undefined;

    this.apiGatewayHttpService.logAudit({
      at: new Date().toISOString(),
      method: params.request.method,
      path: params.request.originalUrl,
      ipAddress: resolveIpAddress(params.request.headers, params.request.ip),
      authType: params.request.gatewayAuth?.authType ?? "public",
      userId: params.request.gatewayAuth?.userId,
      apiKeyId: params.request.gatewayAuth?.apiKeyId,
      sessionId: params.request.gatewayAuth?.sessionId,
      idempotencyKey: readHeader(params.request.headers, "idempotency-key"),
      statusCode: error?.getStatus?.() ?? error?.status ?? params.response.statusCode,
      errorCode: error?.code,
      errorMessage: error?.message,
      durationMs: params.durationMs,
      rateLimitRemaining: params.request.gatewayRateLimit?.remaining,
      rateLimitResetAt: params.request.gatewayRateLimit?.resetAt
    });
  }
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function resolveIpAddress(
  headers: Record<string, string | string[] | undefined>,
  fallback: string | undefined
): string {
  const forwarded = readHeader(headers, "x-forwarded-for");
  if (forwarded) {
    const [first] = forwarded.split(",");
    const trimmed = first?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return fallback ?? "0.0.0.0";
}
