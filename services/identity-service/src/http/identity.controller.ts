import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseFilters
} from "@nestjs/common";

import type {
  CreateApiKeyRequestDto,
  CreateCustomerSessionRequestDto,
  CreateOpsSessionRequestDto,
  CreateUserRequestDto,
  DisableTwoFactorRequestDto,
  ListKycRequestsQueryDto,
  RegenerateRecoveryCodesRequestDto,
  ReviewKycRequestDto,
  SetKycTierRequestDto,
  SubmitKycRequestDto,
  EnableTwoFactorRequestDto,
  EnrollTwoFactorRequestDto,
  FreezeUserRequestDto,
  VerifyApiKeySignatureRequestDto,
  ListUsersQueryDto,
  RegisterCustomerRequestDto,
  VerifyTwoFactorRequestDto
} from "./dto.js";
import { IdentityExceptionFilter } from "./identity-exception.filter.js";
import { IdentityHttpService } from "./identity-http.service.js";

@UseFilters(IdentityExceptionFilter)
@Controller("/api/v1/identity")
export class IdentityController {
  constructor(private readonly identityHttpService: IdentityHttpService) {}

  @Post("/users")
  async createUser(@Body() body: CreateUserRequestDto) {
    return this.identityHttpService.createUser(body);
  }

  @Post("/auth/register")
  async registerCustomer(@Body() body: RegisterCustomerRequestDto) {
    return this.identityHttpService.registerCustomer(body);
  }

  @Get("/users")
  async listUsers(@Query() query: ListUsersQueryDto) {
    return this.identityHttpService.listUsers({
      userId: query.userId,
      email: query.email,
      status: query.status,
      userType: query.userType,
      role: query.role,
      search: query.search,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/users/:userId")
  async getUser(@Param("userId") userId: string) {
    return this.identityHttpService.getUser(userId);
  }

  @Get("/users/:userId/two-factor")
  async getTwoFactorStatus(@Param("userId") userId: string) {
    return this.identityHttpService.getTwoFactorStatus(userId);
  }

  @Post("/users/:userId/two-factor/enroll")
  async enrollTwoFactor(
    @Param("userId") userId: string,
    @Body() body: EnrollTwoFactorRequestDto
  ) {
    return this.identityHttpService.enrollTwoFactor({
      userId,
      ...body
    });
  }

  @Post("/users/:userId/two-factor/enable")
  async enableTwoFactor(
    @Param("userId") userId: string,
    @Body() body: EnableTwoFactorRequestDto
  ) {
    return this.identityHttpService.enableTwoFactor({
      userId,
      ...body
    });
  }

  @Post("/users/:userId/two-factor/verify")
  async verifyTwoFactor(
    @Param("userId") userId: string,
    @Body() body: VerifyTwoFactorRequestDto
  ) {
    return this.identityHttpService.verifyTwoFactor({
      userId,
      ...body
    });
  }

  @Post("/users/:userId/two-factor/disable")
  async disableTwoFactor(
    @Param("userId") userId: string,
    @Body() body: DisableTwoFactorRequestDto
  ) {
    return this.identityHttpService.disableTwoFactor({
      userId,
      code: String(body?.code ?? "")
    });
  }

  @Post("/users/:userId/two-factor/recovery-codes")
  async regenerateRecoveryCodes(
    @Param("userId") userId: string,
    @Body() body: RegenerateRecoveryCodesRequestDto
  ) {
    return this.identityHttpService.regenerateRecoveryCodes({
      userId,
      code: String(body?.code ?? "")
    });
  }

  @Get("/users/:userId/kyc")
  async getKycProfile(@Param("userId") userId: string) {
    return this.identityHttpService.getKycProfile(userId);
  }

  @Post("/users/:userId/kyc/requests")
  async submitKycRequest(@Param("userId") userId: string, @Body() body: SubmitKycRequestDto) {
    return this.identityHttpService.submitKycRequest({
      userId,
      requestedTier: body?.requestedTier,
      fullName: body?.fullName,
      idNumber: body?.idNumber
    });
  }

  @Post("/users/:userId/kyc/tier")
  async setKycTier(@Param("userId") userId: string, @Body() body: SetKycTierRequestDto) {
    return this.identityHttpService.setKycTier({
      userId,
      tier: body?.tier,
      actorId: body?.actorId,
      reason: body?.reason
    });
  }

  @Get("/kyc/requests")
  async listKycRequests(@Query() query: ListKycRequestsQueryDto) {
    return this.identityHttpService.listKycRequests({
      userId: query.userId,
      status: query.status,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Post("/kyc/requests/:requestId/approve")
  async approveKycRequest(
    @Param("requestId") requestId: string,
    @Body() body: ReviewKycRequestDto
  ) {
    return this.identityHttpService.approveKycRequest({
      requestId,
      reviewedBy: body?.reviewedBy,
      tier: body?.tier,
      note: body?.note
    });
  }

  @Post("/kyc/requests/:requestId/reject")
  async rejectKycRequest(
    @Param("requestId") requestId: string,
    @Body() body: ReviewKycRequestDto
  ) {
    return this.identityHttpService.rejectKycRequest({
      requestId,
      reviewedBy: body?.reviewedBy,
      note: body?.note
    });
  }

  @Post("/ops/sessions")
  async createOpsSession(
    @Body() body: CreateOpsSessionRequestDto,
    @Headers("user-agent") userAgent?: string,
    @Headers("x-forwarded-for") forwardedFor?: string
  ) {
    return this.identityHttpService.createOpsSession({
      ...body,
      userAgent,
      ipAddress: parseForwardedFor(forwardedFor)
    });
  }

  @Post("/auth/sessions")
  async createCustomerSession(
    @Body() body: CreateCustomerSessionRequestDto,
    @Headers("user-agent") userAgent?: string,
    @Headers("x-forwarded-for") forwardedFor?: string
  ) {
    return this.identityHttpService.createCustomerSession({
      ...body,
      userAgent,
      ipAddress: parseForwardedFor(forwardedFor)
    });
  }

  @Get("/ops/sessions/current")
  async getCurrentOpsSession(@Headers("authorization") authorization?: string) {
    return this.identityHttpService.introspectOpsSession(readBearerToken(authorization));
  }

  @Get("/auth/sessions/current")
  async getCurrentCustomerSession(@Headers("authorization") authorization?: string) {
    return this.identityHttpService.introspectCustomerSession(readBearerToken(authorization));
  }

  @Post("/ops/sessions/logout")
  async revokeCurrentOpsSession(@Headers("authorization") authorization?: string) {
    return this.identityHttpService.revokeOpsSession(readBearerToken(authorization));
  }

  @Post("/auth/sessions/logout")
  async revokeCurrentCustomerSession(@Headers("authorization") authorization?: string) {
    return this.identityHttpService.revokeCustomerSession(readBearerToken(authorization));
  }

  @Post("/users/:userId/api-keys")
  async createApiKey(
    @Param("userId") userId: string,
    @Body() body: CreateApiKeyRequestDto
  ) {
    return this.identityHttpService.createApiKey({
      userId,
      ...body
    });
  }

  @Get("/users/:userId/api-keys")
  async listApiKeys(@Param("userId") userId: string) {
    return this.identityHttpService.listApiKeys(userId);
  }

  @Post("/users/:userId/api-keys/:apiKeyId/revoke")
  async revokeApiKey(@Param("apiKeyId") apiKeyId: string) {
    return this.identityHttpService.revokeApiKey(apiKeyId);
  }

  @Post("/internal/api-keys/verify-signature")
  async verifyApiKeySignature(@Body() body: VerifyApiKeySignatureRequestDto) {
    return this.identityHttpService.verifyApiKeySignature({
      keyId: String(body.keyId ?? ""),
      canonicalRequest: String(body.canonicalRequest ?? ""),
      signature: String(body.signature ?? "")
    });
  }

  @Post("/users/:userId/freeze")
  async freezeUser(
    @Param("userId") userId: string,
    @Body() body: FreezeUserRequestDto
  ) {
    return this.identityHttpService.freezeUser({
      userId,
      reason: body.reason
    });
  }

  @Post("/users/:userId/unfreeze")
  async unfreezeUser(@Param("userId") userId: string) {
    return this.identityHttpService.unfreezeUser({
      userId
    });
  }
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function parseForwardedFor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const [first] = value.split(",");
  const trimmed = first?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
