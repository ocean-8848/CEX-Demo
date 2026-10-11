import { Module } from "@nestjs/common";

import { CustodyController } from "./custody.controller.js";
import { CustodyExceptionFilter } from "./custody-exception.filter.js";
import { CustodyHttpService } from "./custody-http.service.js";

@Module({
  controllers: [CustodyController],
  providers: [CustodyHttpService, CustodyExceptionFilter]
})
export class CustodyModule {}
