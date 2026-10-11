import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { OrderController, OrderOpsController, TradeController } from "./order.controller.js";
import { OrderExceptionFilter } from "./order-exception.filter.js";
import { OrderHttpService } from "./order-http.service.js";
import { InternalServiceAuthGuard } from "./internal-service-auth.guard.js";

@Module({
  controllers: [OrderController, TradeController, OrderOpsController],
  providers: [
    OrderHttpService,
    OrderExceptionFilter,
    InternalServiceAuthGuard,
    {
      provide: APP_GUARD,
      useExisting: InternalServiceAuthGuard
    }
  ]
})
export class OrderModule {}
