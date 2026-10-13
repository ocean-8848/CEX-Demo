import { Controller, Get, UseFilters, UseGuards } from "@nestjs/common";

import { PublicGatewayRoute } from "./api-gateway-auth.decorator.js";
import { ApiGatewayAuthGuard } from "./api-gateway-auth.guard.js";
import { gatewayControlSwitchReader } from "./api-gateway-control-switch.guard.js";
import { ApiGatewayExceptionFilter } from "./api-gateway-exception.filter.js";
import { ApiGatewayRateLimitGuard } from "./api-gateway-rate-limit.guard.js";

/**
 * Public, read-only platform status for trader-web banners. Internal details
 * (ops reasons, operator names) are not exposed — only what is switched on.
 */
@UseFilters(ApiGatewayExceptionFilter)
@UseGuards(ApiGatewayAuthGuard, ApiGatewayRateLimitGuard)
@Controller("/api/v1/gateway/system")
export class ApiGatewaySystemController {
  @PublicGatewayRoute()
  @Get("/controls")
  async getControls() {
    const state = await gatewayControlSwitchReader().getState();
    return {
      generatedAt: state.generatedAt,
      withdrawalsPaused: Boolean(state.withdrawalsPaused),
      pausedWithdrawalAssets: state.assetWithdrawalPauses
        .map((entry) => entry.assetCode)
        .filter((assetCode): assetCode is string => Boolean(assetCode)),
      apiWriteFrozen: Boolean(state.apiWriteFrozen)
    };
  }
}
