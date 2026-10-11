import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus
} from "@nestjs/common";

import { LedgerError } from "../domain/errors.js";

function mapLedgerErrorCodeToStatus(code: LedgerError["code"]): number {
  switch (code) {
    case "ACCOUNT_NOT_FOUND":
    case "BALANCE_NOT_FOUND":
    case "BALANCE_LOCK_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "DUPLICATE_BALANCE_LOCK":
    case "DUPLICATE_IDEMPOTENCY_KEY":
    case "INVALID_BALANCE_LOCK_STATE":
      return HttpStatus.CONFLICT;
    case "INSUFFICIENT_AVAILABLE_BALANCE":
    case "INVALID_AMOUNT":
    case "JOURNAL_NOT_BALANCED":
    case "SETTLEMENT_ACCOUNT_REQUIRED":
      return HttpStatus.BAD_REQUEST;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch(LedgerError)
export class LedgerExceptionFilter implements ExceptionFilter {
  catch(exception: LedgerError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();
    const status = mapLedgerErrorCodeToStatus(exception.code);

    response.status(status).json({
      code: exception.code,
      message: exception.message
    });
  }
}
