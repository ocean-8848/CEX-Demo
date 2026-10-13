import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseFilters } from "@nestjs/common";
import { isSpotMarket } from "@web3-cex/domain";

import { OrderExceptionFilter } from "./order-exception.filter.js";
import { OrderHttpService } from "./order-http.service.js";

interface FeeTierOverrideRequestDto {
  tier?: string;
  note?: string;
  actor?: string;
}

/** A7 VIP fee tiers. Internal (HMAC) like every order-service route. */
@UseFilters(OrderExceptionFilter)
@Controller("/api/v1/fee-tiers")
export class FeeTierController {
  constructor(private readonly orderHttpService: OrderHttpService) {}

  @Get()
  getConfig() {
    return this.orderHttpService.feeTiers.getConfig();
  }

  @Get("/overrides")
  async listOverrides() {
    return { items: await this.orderHttpService.feeTiers.listOverrides() };
  }

  @Get("/audit")
  async listAudit(@Query("userId") userId?: string, @Query("limit") limit?: string) {
    return {
      items: await this.orderHttpService.feeTiers.listAudit({
        userId: userId || undefined,
        limit: limit ? Number(limit) : undefined
      })
    };
  }

  @Get("/users/:userId")
  async getProfile(@Param("userId") userId: string) {
    return this.orderHttpService.feeTiers.getProfile(userId);
  }

  @Post("/users/:userId/override")
  async setOverride(@Param("userId") userId: string, @Body() body: FeeTierOverrideRequestDto) {
    return this.orderHttpService.feeTiers.setOverride({
      userId,
      tier: body?.tier ?? "",
      note: body?.note,
      actor: body?.actor
    });
  }

  @Post("/users/:userId/override/clear")
  async clearOverride(@Param("userId") userId: string, @Body() body: FeeTierOverrideRequestDto) {
    return this.orderHttpService.feeTiers.clearOverride({ userId, note: body?.note, actor: body?.actor });
  }
}

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A9 surveillance activity window, read by risk-service. */
@UseFilters(OrderExceptionFilter)
@Controller("/api/v1/surveillance")
export class SurveillanceDataController {
  constructor(private readonly orderHttpService: OrderHttpService) {}

  @Get("/activity")
  async getActivity(
    @Query()
    query: {
      since?: string;
      until?: string;
      market?: string;
      tradeLimit?: string;
      orderMinNotional?: string;
      orderMaxLifetimeMs?: string;
      orderLimit?: string;
      orderExcludeUserIds?: string;
    }
  ) {
    const until = query.until ? new Date(query.until) : new Date();
    const since = query.since ? new Date(query.since) : new Date(until.getTime() - 60 * 60 * 1000);
    if (Number.isNaN(until.getTime()) || Number.isNaN(since.getTime()) || since > until) {
      throw new BadRequestException("since / until must be ISO timestamps with since <= until");
    }
    if (until.getTime() - since.getTime() > MAX_WINDOW_MS) {
      throw new BadRequestException("window must be at most 24h");
    }
    if (query.market && !isSpotMarket(query.market)) {
      throw new BadRequestException(`unsupported market ${query.market}`);
    }
    const minNotional = query.orderMinNotional ?? "0";
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(minNotional)) {
      throw new BadRequestException("orderMinNotional must be a decimal string");
    }
    return this.orderHttpService.surveillanceData.getActivity({
      since: since.toISOString(),
      until: until.toISOString(),
      market: query.market || undefined,
      tradeLimit: clampInteger(query.tradeLimit, 5000, 1, 20000),
      orderMinNotional: minNotional,
      orderMaxLifetimeMs: clampInteger(query.orderMaxLifetimeMs, 30_000, 0, MAX_WINDOW_MS),
      orderLimit: clampInteger(query.orderLimit, 2000, 1, 20000),
      orderExcludeUserIds: (query.orderExcludeUserIds ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 100)
    });
  }
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), min), max) : fallback;
}
