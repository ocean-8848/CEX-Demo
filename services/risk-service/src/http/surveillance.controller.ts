import { Body, Controller, Get, Param, Post, Query, UseFilters } from "@nestjs/common";

import type { SurveillanceAlertStatus, SurveillanceAlertType } from "../domain/surveillance.js";
import { RiskExceptionFilter } from "./risk-exception.filter.js";
import { SurveillanceHttpService } from "./surveillance-http.service.js";

/** A9 market surveillance (internal; ops-console proxies it). */
@UseFilters(RiskExceptionFilter)
@Controller("/api/v1/risk/surveillance")
export class SurveillanceController {
  constructor(private readonly surveillance: SurveillanceHttpService) {}

  @Get("/overview")
  async getOverview() {
    return this.surveillance.service.getOverview();
  }

  @Post("/scan")
  async scan() {
    return this.surveillance.service.scan("manual");
  }

  @Get("/alerts")
  async listAlerts(
    @Query()
    query: {
      type?: string;
      status?: string;
      market?: string;
      userId?: string;
      includeMarketMakers?: string;
      limit?: string;
      offset?: string;
    }
  ) {
    return this.surveillance.service.listAlerts({
      type: (query.type || undefined) as SurveillanceAlertType | undefined,
      status: (query.status || undefined) as SurveillanceAlertStatus | undefined,
      market: query.market || undefined,
      userId: query.userId || undefined,
      includeMarketMakers: query.includeMarketMakers === "true",
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined
    });
  }

  @Get("/alerts/:alertId")
  async getAlert(@Param("alertId") alertId: string) {
    return this.surveillance.service.getAlert(alertId);
  }

  @Post("/alerts/:alertId/status")
  async updateStatus(
    @Param("alertId") alertId: string,
    @Body() body: { status?: string; note?: string; actor?: string }
  ) {
    return this.surveillance.service.updateStatus({
      alertId,
      status: body?.status,
      note: typeof body?.note === "string" ? body.note : undefined,
      actor: typeof body?.actor === "string" ? body.actor : undefined
    });
  }
}
