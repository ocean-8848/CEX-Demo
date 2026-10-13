import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";

import type { GatewayPrincipal, RateLimitDecision } from "../domain/types.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";
import { resolveClientIp } from "./client-ip.js";

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
      ipAddress: resolveClientIp(request)
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

