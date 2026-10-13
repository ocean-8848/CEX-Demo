import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus
} from "@nestjs/common";

import { IdentityError } from "../domain/errors.js";

function mapIdentityErrorCodeToStatus(code: IdentityError["code"]): number {
  switch (code) {
    case "USER_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "OPS_ACCESS_DENIED":
      return HttpStatus.FORBIDDEN;
    case "USER_ALREADY_EXISTS":
    case "TWO_FACTOR_ALREADY_ENABLED":
    case "TWO_FACTOR_CODE_REUSED":
    case "KYC_REQUEST_PENDING":
    case "KYC_REQUEST_ALREADY_REVIEWED":
      return HttpStatus.CONFLICT;
    case "KYC_REQUEST_INVALID":
      return HttpStatus.BAD_REQUEST;
    case "KYC_REQUEST_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "KYC_NOT_ALLOWED":
    case "TWO_FACTOR_RECOVERY_CODE_INVALID":
      return HttpStatus.FORBIDDEN;
    case "INVALID_CREDENTIALS":
    case "OPS_SESSION_NOT_FOUND":
    case "OPS_SESSION_EXPIRED":
    case "OPS_SESSION_REVOKED":
    case "CUSTOMER_SESSION_NOT_FOUND":
    case "CUSTOMER_SESSION_EXPIRED":
    case "CUSTOMER_SESSION_REVOKED":
      return HttpStatus.UNAUTHORIZED;
    case "USER_NOT_ACTIVE":
    case "USER_FREEZE_NOT_ALLOWED":
    case "TWO_FACTOR_NOT_ENROLLED":
    case "TWO_FACTOR_NOT_ENABLED":
    case "TWO_FACTOR_REQUIRED":
    case "TWO_FACTOR_INVALID_CODE":
    case "OPS_TWO_FACTOR_REQUIRED":
      return HttpStatus.FORBIDDEN;
    case "INVALID_API_KEY_LABEL":
    case "INVALID_API_KEY_SCOPE":
      return HttpStatus.BAD_REQUEST;
    case "INVALID_API_KEY_SIGNATURE":
      return HttpStatus.UNAUTHORIZED;
    case "API_KEY_NOT_FOUND":
    case "DEVICE_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "LOGIN_TEMPORARILY_LOCKED":
      return HttpStatus.TOO_MANY_REQUESTS;
    case "API_KEY_REVOKED":
      return HttpStatus.CONFLICT;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch(IdentityError)
export class IdentityExceptionFilter implements ExceptionFilter {
  catch(exception: IdentityError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();

    response.status(mapIdentityErrorCodeToStatus(exception.code)).json({
      code: exception.code,
      message: exception.message
    });
  }
}
