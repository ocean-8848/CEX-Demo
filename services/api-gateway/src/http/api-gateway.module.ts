import { Module } from "@nestjs/common";

import { ApiGatewayAuditInterceptor } from "./api-gateway-audit.interceptor.js";
import { ApiGatewayController } from "./api-gateway.controller.js";
import { ApiGatewayAuthGuard } from "./api-gateway-auth.guard.js";
import { ApiGatewayExceptionFilter } from "./api-gateway-exception.filter.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";
import { ApiGatewayIdempotencyInterceptor } from "./api-gateway-idempotency.interceptor.js";
import { ApiGatewayRateLimitGuard } from "./api-gateway-rate-limit.guard.js";
import { FeeTierController } from "./fee-tier.controller.js";

@Module({
  controllers: [ApiGatewayController, FeeTierController],
  providers: [
    ApiGatewayHttpService,
    ApiGatewayAuthGuard,
    ApiGatewayRateLimitGuard,
    ApiGatewayAuditInterceptor,
    ApiGatewayIdempotencyInterceptor,
    ApiGatewayExceptionFilter
  ]
})
export class ApiGatewayModule {}
