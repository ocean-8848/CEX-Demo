import { Controller, Get, Param, Post, Query, UseFilters } from "@nestjs/common";

import type { LoginOutcome } from "../domain/login-security.js";
import { IdentityExceptionFilter } from "./identity-exception.filter.js";
import { IdentityHttpService } from "./identity-http.service.js";

/**
 * Login history, devices and device revocation. Internal routes (HMAC guard):
 * api-gateway calls them for the signed-in customer, ops-console for any user,
 * wallet-service reads /login-security for the optional new-device lock.
 */
@UseFilters(IdentityExceptionFilter)
@Controller("/api/v1/identity/users/:userId")
export class LoginSecurityController {
  constructor(private readonly identityHttpService: IdentityHttpService) {}

  @Get("/login-events")
  async listLoginEvents(
    @Param("userId") userId: string,
    @Query("outcome") outcome?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.identityHttpService.loginSecurity.listLoginEvents({
      userId,
      outcome: isLoginOutcome(outcome) ? outcome : undefined,
      limit: parseOptionalNumber(limit),
      offset: parseOptionalNumber(offset)
    });
  }

  @Get("/devices")
  async listDevices(@Param("userId") userId: string) {
    return { items: await this.identityHttpService.loginSecurity.listDevices(userId) };
  }

  @Post("/devices/:deviceId/revoke")
  async revokeDevice(@Param("userId") userId: string, @Param("deviceId") deviceId: string) {
    return this.identityHttpService.loginSecurity.revokeDevice(userId, deviceId);
  }

  @Get("/login-security")
  async getLoginSecuritySummary(@Param("userId") userId: string) {
    return this.identityHttpService.loginSecurity.getLoginSecuritySummary(userId);
  }
}

function isLoginOutcome(value: string | undefined): value is LoginOutcome {
  return value === "success" || value === "failure" || value === "locked";
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
