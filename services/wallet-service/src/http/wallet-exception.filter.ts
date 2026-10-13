import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus
} from "@nestjs/common";

import { WalletError } from "../domain/errors.js";

function mapWalletErrorCodeToStatus(code: WalletError["code"]): number {
  switch (code) {
    case "ADDRESS_NOT_FOUND":
    case "ADDRESS_BOOK_ENTRY_NOT_FOUND":
    case "IDENTITY_USER_NOT_FOUND":
    case "WITHDRAWAL_NOT_FOUND":
    case "NOTIFICATION_NOT_FOUND":
    case "BLACKLIST_ENTRY_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "DEPOSIT_ALREADY_CREDITED":
    case "INVALID_WITHDRAWAL_STATE":
    case "WITHDRAWAL_SAME_APPROVER":
    case "WITHDRAWALS_PAUSED":
    case "ASSET_WITHDRAWALS_PAUSED":
    case "API_WRITE_FROZEN":
      return HttpStatus.CONFLICT;
    case "WITHDRAWAL_APPROVER_REQUIRED":
      return HttpStatus.BAD_REQUEST;
    case "WITHDRAWAL_SECURITY_COOLDOWN":
    case "WITHDRAWAL_ADDRESS_BLOCKED":
    case "WITHDRAWAL_NEW_DEVICE_LOCK":
      return HttpStatus.FORBIDDEN;
    case "INVALID_BLACKLIST_ENTRY":
      return HttpStatus.BAD_REQUEST;
    case "INVALID_CONFIRMATION_COUNT":
    case "INVALID_AMOUNT":
    case "UNSUPPORTED_ASSET":
    case "INVALID_ADDRESS_BOOK_LABEL":
    case "INVALID_DESTINATION_ADDRESS":
    case "WITHDRAWAL_AMOUNT_BELOW_MINIMUM":
    case "WITHDRAWAL_FEE_BELOW_MINIMUM":
    case "WITHDRAWAL_SINGLE_LIMIT_EXCEEDED":
    case "WITHDRAWAL_DAILY_LIMIT_EXCEEDED":
      return HttpStatus.BAD_REQUEST;
    case "WITHDRAWAL_2FA_INVALID":
    case "WITHDRAWAL_2FA_NOT_ENABLED":
    case "WITHDRAWAL_2FA_REQUIRED":
    case "WITHDRAWAL_ADDRESS_NOT_WHITELISTED":
      return HttpStatus.FORBIDDEN;
    case "CUSTODY_TRANSFER_FAILED":
    case "IDENTITY_SERVICE_FAILED":
    case "LEDGER_CONSUME_FAILED":
    case "LEDGER_FREEZE_FAILED":
    case "LEDGER_RELEASE_FAILED":
    case "LEDGER_POST_FAILED":
      return HttpStatus.BAD_GATEWAY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch(WalletError)
export class WalletExceptionFilter implements ExceptionFilter {
  catch(exception: WalletError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();

    response.status(mapWalletErrorCodeToStatus(exception.code)).json({
      code: exception.code,
      message: exception.message
    });
  }
}
