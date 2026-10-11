import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseFilters
} from "@nestjs/common";
import type { AssetCode } from "@web3-cex/domain";

import type {
  ConsumeBalanceRequestDto,
  CreateAccountRequestDto,
  DrainLedgerOutboxRequestDto,
  FreezeBalanceRequestDto,
  GetLedgerOpsOverviewQueryDto,
  GetLedgerReconciliationQueryDto,
  GetLedgerReplayQueryDto,
  ListBalancesQueryDto,
  ListEntriesQueryDto,
  ListJournalsQueryDto,
  PostJournalRequestDto,
  ReleaseBalanceRequestDto
} from "./dto.js";
import type {
  GetAccountStatementQueryDto,
  RunLedgerReconciliationRequestDto,
  RunLedgerReplayRequestDto
} from "./dto.js";
import type { StatementCategoryFilter } from "../domain/types.js";

const STATEMENT_CATEGORIES: StatementCategoryFilter[] = [
  "deposit",
  "withdrawal",
  "trade",
  "adjustment",
  "fee"
];
import { LedgerExceptionFilter } from "./ledger-exception.filter.js";
import { LedgerHttpService } from "./ledger-http.service.js";

@UseFilters(LedgerExceptionFilter)
@Controller("/api/v1/ledger")
export class LedgerController {
  constructor(private readonly ledgerHttpService: LedgerHttpService) {}

  @Post("/accounts")
  async createAccount(@Body() body: CreateAccountRequestDto) {
    return this.ledgerHttpService.createAccount(body);
  }

  @Get("/accounts/:accountId")
  async getAccount(@Param("accountId") accountId: string) {
    const account = await this.ledgerHttpService.getAccount(accountId);

    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }

    return account;
  }

  @Post("/journals")
  async postJournal(@Body() body: PostJournalRequestDto) {
    return this.ledgerHttpService.postJournal(body);
  }

  @Get("/journals")
  async listJournals(@Query() query: ListJournalsQueryDto) {
    return this.ledgerHttpService.listJournals({
      businessType: query.businessType,
      businessId: query.businessId,
      idempotencyKey: query.idempotencyKey,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/balances")
  async listBalances(@Query() query: ListBalancesQueryDto) {
    return this.ledgerHttpService.listBalances({
      userId: query.userId,
      accountId: query.accountId,
      assetCode: query.assetCode,
      accountType: query.accountType,
      accountStatus: query.accountStatus,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/ops/reconciliation")
  async getReconciliationReport(@Query() query: GetLedgerReconciliationQueryDto) {
    return this.ledgerHttpService.getReconciliationReport({
      accountId: query.accountId,
      assetCode: query.assetCode,
      includeMatched: parseOptionalBoolean(query.includeMatched)
    });
  }

  @Post("/ops/reconciliation/run")
  async runReconciliation(@Body() body: RunLedgerReconciliationRequestDto) {
    return this.ledgerHttpService.getReconciliationReport(body);
  }

  @Get("/ops/replay")
  async getReplayReport(@Query() query: GetLedgerReplayQueryDto) {
    if (!query.accountId || !query.assetCode) {
      throw new BadRequestException("accountId and assetCode are required");
    }

    return this.ledgerHttpService.getReplayReport({
      accountId: query.accountId,
      assetCode: query.assetCode
    });
  }

  @Post("/ops/replay/run")
  async runReplay(@Body() body: RunLedgerReplayRequestDto) {
    if (!body.accountId || !body.assetCode) {
      throw new BadRequestException("accountId and assetCode are required");
    }

    return this.ledgerHttpService.getReplayReport({
      accountId: body.accountId,
      assetCode: body.assetCode
    });
  }

  @Get("/ops/overview")
  async getOpsOverview(@Query() query: GetLedgerOpsOverviewQueryDto) {
    return this.ledgerHttpService.getOpsOverview({
      staleLockMinutes: parseOptionalNumber(query.staleLockMinutes)
    });
  }

  @Post("/ops/outbox/drain")
  async drainOutboxAlerts(@Body() body: DrainLedgerOutboxRequestDto) {
    return this.ledgerHttpService.drainOutboxAlerts(body);
  }

  @Get("/journals/:journalId")
  async getJournal(@Param("journalId") journalId: string) {
    const journal = await this.ledgerHttpService.getJournal(journalId);

    if (!journal) {
      throw new NotFoundException(`Journal ${journalId} not found`);
    }

    return journal;
  }

  @Post("/balances/freeze")
  async freezeBalance(@Body() body: FreezeBalanceRequestDto) {
    return this.ledgerHttpService.freezeBalance(body);
  }

  @Post("/balances/release")
  async releaseBalance(@Body() body: ReleaseBalanceRequestDto) {
    return this.ledgerHttpService.releaseBalance(body);
  }

  @Post("/balances/consume")
  async consumeBalance(@Body() body: ConsumeBalanceRequestDto) {
    return this.ledgerHttpService.consumeBalance(body);
  }

  @Get("/balances/:accountId/:assetCode")
  async getBalance(
    @Param("accountId") accountId: string,
    @Param("assetCode") assetCode: AssetCode
  ) {
    return this.ledgerHttpService.getBalance(accountId, assetCode);
  }

  @Get("/accounts/:accountId/entries")
  async listEntries(
    @Param("accountId") accountId: string,
    @Query() query: ListEntriesQueryDto
  ) {
    return this.ledgerHttpService.listEntries({
      accountId,
      assetCode: query.assetCode,
      journalId: query.journalId,
      businessType: query.businessType,
      businessId: query.businessId,
      referenceType: query.referenceType,
      referenceId: query.referenceId,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
    });
  }

  @Get("/accounts/:accountId/statement")
  async getAccountStatement(
    @Param("accountId") accountId: string,
    @Query() query: GetAccountStatementQueryDto
  ) {
    if (query.category && !STATEMENT_CATEGORIES.includes(query.category as StatementCategoryFilter)) {
      throw new BadRequestException(
        `category must be one of ${STATEMENT_CATEGORIES.join(", ")}`
      );
    }
    for (const [name, value] of [
      ["from", query.from],
      ["to", query.to]
    ] as const) {
      if (value && !Number.isFinite(Date.parse(value))) {
        throw new BadRequestException(`${name} must be an ISO-8601 timestamp`);
      }
    }

    return this.ledgerHttpService.getAccountStatement({
      accountId,
      assetCode: query.assetCode,
      category: query.category as StatementCategoryFilter | undefined,
      businessType: query.businessType,
      includeLockEvents: parseOptionalBoolean(query.includeLockEvents),
      from: query.from,
      to: query.to,
      limit: parseOptionalNumber(query.limit),
      offset: parseOptionalNumber(query.offset)
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

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}
