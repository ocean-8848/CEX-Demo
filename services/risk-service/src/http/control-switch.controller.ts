import { Body, Controller, Get, Post, Query, UseFilters } from "@nestjs/common";
import type { ControlSwitchScope, ControlSwitchSource } from "@web3-cex/domain";

import { RiskExceptionFilter } from "./risk-exception.filter.js";
import { RiskHttpService } from "./risk-http.service.js";

interface SetControlSwitchRequestDto {
  scope?: ControlSwitchScope;
  assetCode?: string;
  enabled?: boolean;
  reason?: string;
  operator?: string;
  source?: ControlSwitchSource;
}

/**
 * Emergency switches (global / per-asset withdrawal pause, API write freeze).
 * Read by wallet-service, api-gateway and ops-console; written by ops-console
 * (manual) and the ledger-service reconciliation breaker (automatic).
 */
@UseFilters(RiskExceptionFilter)
@Controller("/api/v1/risk/controls")
export class ControlSwitchController {
  constructor(private readonly riskHttpService: RiskHttpService) {}

  @Get()
  async getState() {
    return this.riskHttpService.getControlSwitches();
  }

  @Post()
  async setSwitch(@Body() body: SetControlSwitchRequestDto) {
    return this.riskHttpService.setControlSwitch({
      scope: body?.scope as ControlSwitchScope,
      assetCode: typeof body?.assetCode === "string" ? body.assetCode : undefined,
      enabled: body?.enabled as boolean,
      reason: typeof body?.reason === "string" ? body.reason : undefined,
      operator: typeof body?.operator === "string" ? body.operator : undefined,
      source: body?.source === "automatic" ? "automatic" : "manual"
    });
  }

  @Get("/events")
  async listEvents(@Query("limit") limit?: string) {
    return { items: await this.riskHttpService.listControlSwitchEvents(limit ? Number(limit) : undefined) };
  }
}
