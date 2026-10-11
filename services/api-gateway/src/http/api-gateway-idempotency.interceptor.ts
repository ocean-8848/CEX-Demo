import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  Observable,
  catchError,
  from,
  map,
  mergeMap,
  of,
  switchMap,
  throwError
} from "rxjs";

import type { GatewayPrincipal } from "../domain/types.js";
import { API_GATEWAY_IDEMPOTENT_ROUTE_KEY } from "./api-gateway-idempotency.decorator.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";

@Injectable()
export class ApiGatewayIdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiGatewayHttpService: ApiGatewayHttpService
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const idempotent =
      this.reflector.getAllAndOverride<boolean>(API_GATEWAY_IDEMPOTENT_ROUTE_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? false;

    if (!idempotent) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<{
      method: string;
      originalUrl: string;
      rawBody?: Buffer | string;
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      gatewayAuth?: GatewayPrincipal;
    }>();
    const response = http.getResponse<{
      status(code: number): void;
      setHeader(name: string, value: string): void;
      statusCode: number;
    }>();
    const idempotencyKey = readHeader(request.headers, "idempotency-key");

    if (!idempotencyKey) {
      return next.handle();
    }

    return from(
      this.apiGatewayHttpService.beginIdempotentRequest({
        principal: request.gatewayAuth,
        ipAddress: resolveIpAddress(request.headers, request.ip),
        method: request.method,
        url: request.originalUrl,
        rawBody: request.rawBody,
        idempotencyKey
      })
    ).pipe(
      switchMap((claim) => {
        if (claim.outcome === "replay") {
          response.status(claim.statusCode ?? HttpStatus.OK);
          response.setHeader("x-idempotent-replay", "true");
          return of(claim.responseBody ? JSON.parse(claim.responseBody) : {});
        }

        if (claim.outcome === "conflict") {
          throw new ConflictException(
            "Idempotency-Key has already been used with a different request payload"
          );
        }

        if (claim.outcome === "in_flight") {
          throw new ConflictException("A request with this Idempotency-Key is still processing");
        }

        return next.handle().pipe(
          mergeMap((body) =>
            from(
              this.apiGatewayHttpService.completeIdempotentRequest({
                principal: request.gatewayAuth,
                ipAddress: resolveIpAddress(request.headers, request.ip),
                method: request.method,
                url: request.originalUrl,
                rawBody: request.rawBody,
                idempotencyKey,
                statusCode: response.statusCode,
                responseBody: JSON.stringify(body ?? {})
              })
            ).pipe(map(() => body))
          ),
          catchError((error: unknown) =>
            from(
              this.apiGatewayHttpService.abortIdempotentRequest({
                principal: request.gatewayAuth,
                ipAddress: resolveIpAddress(request.headers, request.ip),
                method: request.method,
                url: request.originalUrl,
                rawBody: request.rawBody,
                idempotencyKey
              })
            ).pipe(switchMap(() => throwError(() => error)))
          )
        );
      })
    );
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
