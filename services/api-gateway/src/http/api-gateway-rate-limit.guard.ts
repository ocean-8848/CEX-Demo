import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";

import type { GatewayPrincipal, RateLimitDecision } from "../domain/types.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";

@Injectable()
export class ApiGatewayRateLimitGuard implements CanActivate {
  constructor(private readonly apiGatewayHttpService: ApiGatewayHttpService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
      gatewayAuth?: GatewayPrincipal;
      gatewayRateLimit?: RateLimitDecision;
    }>();
    const response = http.getResponse<{
      setHeader(name: string, value: string | number): void;
    }>();

    const decision = await this.apiGatewayHttpService.consumeRateLimit({
      principal: request.gatewayAuth,
      ipAddress: resolveIpAddress(request.headers, request.ip)
    });

    request.gatewayRateLimit = decision;
    response.setHeader("x-rate-limit-limit", decision.limit);
    response.setHeader("x-rate-limit-remaining", decision.remaining);
    response.setHeader("x-rate-limit-reset", decision.resetAt);

    if (!decision.allowed) {
      throw new HttpException(
        `Rate limit exceeded. Retry after ${decision.resetAt}`,
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    return true;
  }
}

function resolveIpAddress(
  headers: Record<string, string | string[] | undefined>,
  fallback: string | undefined
): string {
  const forwarded = headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    const [first] = raw.split(",");
    const trimmed = first?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return fallback ?? "0.0.0.0";
}
