import { Module } from "@nestjs/common";

import { ControlsController } from "./controls.controller.js";
import { FaultLabController } from "./fault-lab.controller.js";
import { OpsAuthGuard } from "./ops-auth.guard.js";
import { OpsConsoleController } from "./ops-console.controller.js";
import { OpsConsoleExceptionFilter } from "./ops-console-exception.filter.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";

@Module({
  controllers: [OpsConsoleController, FaultLabController, ControlsController],
  providers: [OpsConsoleHttpService, OpsConsoleExceptionFilter, OpsAuthGuard]
})
export class OpsConsoleModule {}
