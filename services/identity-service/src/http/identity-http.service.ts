import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

import { IdentityApplicationService } from "../application/identity-application-service.js";
import type {
  ApiKeyAuthInfo,
  CreateApiKeyCommand,
  CreateCustomerSessionCommand,
  CreateOpsSessionCommand,
  CreateUserCommand,
  CreatedCustomerSession,
  CreatedIdentityApiKey,
  CreatedOpsSession,
  DisableTwoFactorCommand,
  KycProfile,
  KycRequestRecord,
  ListKycRequestsQuery,
  RegenerateRecoveryCodesCommand,
  ReviewKycRequestCommand,
  SetKycTierCommand,
  SubmitKycRequestCommand,
  TwoFactorStatusWithRecoveryCodes,
  EnableTwoFactorCommand,
  EnrollTwoFactorCommand,
  FreezeUserCommand,
  IdentityUser,
  IdentityApiKey,
  ListUsersQuery,
  OpsSessionInfo,
  PagedResult,
  CustomerSessionInfo,
  TwoFactorEnrollment,
  TwoFactorStatus,
  TwoFactorVerificationResult,
  UnfreezeUserCommand,
  VerifyApiKeySignatureCommand,
  VerifyTwoFactorCommand
} from "../domain/types.js";
import type { IdentityRepository } from "../domain/repository.js";
import { InMemoryIdentityRepository } from "../infrastructure/in-memory-identity-repository.js";
import { createIdentityPool } from "../infrastructure/postgres.js";
import { PostgresIdentityRepository } from "../infrastructure/postgres-identity-repository.js";

@Injectable()
export class IdentityHttpService implements OnModuleDestroy {
  private readonly applicationService: IdentityApplicationService;
  private readonly repository: IdentityRepository;
  private readonly pool?: Pool;

  constructor() {
    const repositoryMode = process.env.IDENTITY_REPOSITORY ?? "postgres";

    if (repositoryMode === "memory") {
      this.repository = new InMemoryIdentityRepository();
    } else {
      this.pool = createIdentityPool();
      this.repository = new PostgresIdentityRepository(this.pool, this.pool);
    }

    this.applicationService = new IdentityApplicationService(this.repository, {
      issuer: process.env.TWO_FACTOR_ISSUER ?? "Web3 CEX",
      timeStepSeconds: Number(process.env.TWO_FACTOR_TIME_STEP_SECONDS ?? "30"),
      digits: Number(process.env.TWO_FACTOR_DIGITS ?? "6"),
      window: Number(process.env.TWO_FACTOR_WINDOW ?? "1"),
      opsSessionTtlHours: Number(process.env.OPS_SESSION_TTL_HOURS ?? "12"),
      customerSessionTtlHours: Number(process.env.CUSTOMER_SESSION_TTL_HOURS ?? String(24 * 7)),
      requireOpsTwoFactor: process.env.OPS_REQUIRE_TWO_FACTOR !== "false",
      apiKeyEncryptionKey: process.env.IDENTITY_API_KEY_ENCRYPTION_KEY
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async createUser(command: CreateUserCommand): Promise<IdentityUser> {
    return this.applicationService.createUser(command);
  }

  async registerCustomer(command: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<IdentityUser> {
    return this.applicationService.registerCustomer(command);
  }

  async getUser(userId: string): Promise<IdentityUser> {
    return this.applicationService.getUser(userId);
  }

  async listUsers(query: ListUsersQuery): Promise<PagedResult<IdentityUser>> {
    return this.applicationService.listUsers(query);
  }

  async createOpsSession(command: CreateOpsSessionCommand): Promise<CreatedOpsSession> {
    return this.applicationService.createOpsSession(command);
  }

  async createCustomerSession(
    command: CreateCustomerSessionCommand
  ): Promise<CreatedCustomerSession> {
    return this.applicationService.createCustomerSession(command);
  }

  async introspectOpsSession(token: string): Promise<OpsSessionInfo> {
    return this.applicationService.introspectOpsSession(token);
  }

  async introspectCustomerSession(token: string): Promise<CustomerSessionInfo> {
    return this.applicationService.introspectCustomerSession(token);
  }

  async revokeOpsSession(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.applicationService.revokeOpsSession(token);
  }

  async revokeCustomerSession(token: string): Promise<{ revoked: true; revokedAt: string }> {
    return this.applicationService.revokeCustomerSession(token);
  }

  async createApiKey(command: CreateApiKeyCommand): Promise<CreatedIdentityApiKey> {
    return this.applicationService.createApiKey(command);
  }

  async listApiKeys(userId: string): Promise<IdentityApiKey[]> {
    return this.applicationService.listApiKeys(userId);
  }

  async revokeApiKey(apiKeyId: string): Promise<IdentityApiKey> {
    return this.applicationService.revokeApiKey(apiKeyId);
  }

  async verifyApiKeySignature(command: VerifyApiKeySignatureCommand): Promise<ApiKeyAuthInfo> {
    return this.applicationService.verifyApiKeySignature(command);
  }

  async freezeUser(command: FreezeUserCommand): Promise<IdentityUser> {
    return this.applicationService.freezeUser(command);
  }

  async unfreezeUser(command: UnfreezeUserCommand): Promise<IdentityUser> {
    return this.applicationService.unfreezeUser(command);
  }

  async getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
    return this.applicationService.getTwoFactorStatus(userId);
  }

  async enrollTwoFactor(command: EnrollTwoFactorCommand): Promise<TwoFactorEnrollment> {
    return this.applicationService.enrollTwoFactor(command);
  }

  async enableTwoFactor(command: EnableTwoFactorCommand): Promise<TwoFactorStatusWithRecoveryCodes> {
    return this.applicationService.enableTwoFactor(command);
  }

  async verifyTwoFactor(command: VerifyTwoFactorCommand): Promise<TwoFactorVerificationResult> {
    return this.applicationService.verifyTwoFactor(command);
  }

  async disableTwoFactor(command: DisableTwoFactorCommand): Promise<TwoFactorStatus> {
    return this.applicationService.disableTwoFactor(command);
  }

  async regenerateRecoveryCodes(
    command: RegenerateRecoveryCodesCommand
  ): Promise<TwoFactorStatusWithRecoveryCodes> {
    return this.applicationService.regenerateRecoveryCodes(command);
  }

  async getKycProfile(userId: string): Promise<KycProfile> {
    return this.applicationService.getKycProfile(userId);
  }

  async submitKycRequest(command: SubmitKycRequestCommand): Promise<KycRequestRecord> {
    return this.applicationService.submitKycRequest(command);
  }

  async listKycRequests(query: ListKycRequestsQuery): Promise<PagedResult<KycRequestRecord>> {
    return this.applicationService.listKycRequests(query);
  }

  async approveKycRequest(command: ReviewKycRequestCommand): Promise<KycRequestRecord> {
    return this.applicationService.approveKycRequest(command);
  }

  async rejectKycRequest(command: ReviewKycRequestCommand): Promise<KycRequestRecord> {
    return this.applicationService.rejectKycRequest(command);
  }

  async setKycTier(command: SetKycTierCommand): Promise<KycProfile> {
    return this.applicationService.setKycTier(command);
  }
}
