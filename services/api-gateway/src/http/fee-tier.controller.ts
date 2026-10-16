import { Controller, Get, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";

import type { GatewayPrincipal } from "../domain/types.js";
import { HttpFeeTierClient, toCustomerFeeTierView } from "../infrastructure/http-fee-tier-client.js";
import { CurrentGatewayAuth, RequireApiKeyScope } from "./api-gateway-auth.decorator.js";
import { ApiGatewayAuthGuard } from "./api-gateway-auth.guard.js";
import { ApiGatewayAuditInterceptor } from "./api-gateway-audit.interceptor.js";
import { ApiGatewayExceptionFilter } from "./api-gateway-exception.filter.js";
import { ApiGatewayRateLimitGuard } from "./api-gateway-rate-limit.guard.js";

/** the caller's VIP tier, effective rates, 30-day volume and progress. */
@UseFilters(ApiGatewayExceptionFilter)
@UseGuards(ApiGatewayAuthGuard, ApiGatewayRateLimitGuard)
@UseInterceptors(ApiGatewayAuditInterceptor)
@Controller("/api/v1/gateway/fees")
export class FeeTierController {
  private readonly client = new HttpFeeTierClient(
    process.env.GATEWAY_ORDER_SERVICE_URL ?? "http://127.0.0.1:3009"
  );

  @RequireApiKeyScope("read")
  @Get("/tier")
  async getMyFeeTier(@CurrentGatewayAuth() principal: GatewayPrincipal) {
    return toCustomerFeeTierView(await this.client.getUserProfile(principal.userId));
  }
}
