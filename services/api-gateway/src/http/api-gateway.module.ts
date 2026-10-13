import { Module } from "@nestjs/common";

import { ApiGatewayAuditInterceptor } from "./api-gateway-audit.interceptor.js";
import { ApiGatewayController } from "./api-gateway.controller.js";
import { ApiGatewayAuthGuard } from "./api-gateway-auth.guard.js";
import { ApiGatewayControlSwitchGuard } from "./api-gateway-control-switch.guard.js";
import { ApiGatewaySystemController } from "./api-gateway-system.controller.js";
import { ApiGatewayExceptionFilter } from "./api-gateway-exception.filter.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";
import { ApiGatewayIdempotencyInterceptor } from "./api-gateway-idempotency.interceptor.js";
import { ApiGatewayRateLimitGuard } from "./api-gateway-rate-limit.guard.js";
import { FeeTierController } from "./fee-tier.controller.js";

@Module({
  controllers: [ApiGatewayController, FeeTierController, ApiGatewaySystemController],
  providers: [
    ApiGatewayHttpService,
    ApiGatewayAuthGuard,
    ApiGatewayRateLimitGuard,
    ApiGatewayControlSwitchGuard,
    ApiGatewayAuditInterceptor,
    ApiGatewayIdempotencyInterceptor,
    ApiGatewayExceptionFilter
  ]
})
export class ApiGatewayModule {}
