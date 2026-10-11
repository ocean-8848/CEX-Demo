import { Body, Controller, Get, Param, Post, UseFilters } from "@nestjs/common";

import type { SetMarketStatusRequestDto, ValidateSpotOrderRiskRequestDto } from "./dto.js";
import { RiskExceptionFilter } from "./risk-exception.filter.js";
import { RiskHttpService } from "./risk-http.service.js";

@UseFilters(RiskExceptionFilter)
@Controller("/api/v1/risk")
export class RiskController {
  constructor(private readonly riskHttpService: RiskHttpService) {}

  @Post("/orders/validate")
  async validateSpotOrder(@Body() body: ValidateSpotOrderRiskRequestDto) {
    return this.riskHttpService.validateSpotOrder(body);
  }

  /** Every configured market with its configured and effective status. */
  @Get("/markets")
  async listMarkets() {
    return this.riskHttpService.listMarkets();
  }

  @Get("/markets/:market")
  async getMarket(@Param("market") market: string) {
    return this.riskHttpService.getMarket(market);
  }

  /** Halt (`halted`) or resume (`listed`) a market at runtime. */
  @Post("/markets/:market/status")
  async setMarketStatus(@Param("market") market: string, @Body() body: SetMarketStatusRequestDto) {
    return this.riskHttpService.setMarketStatus({
      market,
      status: body?.status,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
      operator: typeof body?.operator === "string" ? body.operator : undefined
    });
  }
}
