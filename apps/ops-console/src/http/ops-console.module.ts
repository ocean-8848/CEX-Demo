import { Module } from "@nestjs/common";

import { FaultLabController } from "./fault-lab.controller.js";
import { FeesSurveillanceController } from "./fees-surveillance.controller.js";
import { OpsRiskSecurityController } from "./ops-risk-security.controller.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleController } from "./ops-console.controller.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

@Module({
  controllers: [OpsConsoleController, FaultLabController, FeesSurveillanceController, OpsRiskSecurityController],
  providers: [OpsConsoleHttpService, OpsConsoleExceptionFilter, OpsAuthGuard]
})
export class OpsConsoleModule {}
