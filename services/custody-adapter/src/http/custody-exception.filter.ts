import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus
} from "@nestjs/common";

import { CustodyError } from "../domain/errors.js";

function mapCustodyErrorCodeToStatus(code: CustodyError["code"]): number {
  switch (code) {
    case "INVALID_AMOUNT":
    case "INVALID_DESTINATION_ADDRESS":
    case "PROVIDER_UNSUPPORTED_NETWORK":
    case "PROVIDER_UNSUPPORTED_ASSET":
    case "FAULT_LAB_INVALID_TARGET":
      return HttpStatus.BAD_REQUEST;
    case "FAULT_LAB_DISABLED":
      return HttpStatus.FORBIDDEN;
    case "TRANSFER_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "TRANSFER_ALREADY_FINALIZED":
    case "TRANSFER_RETRY_NOT_ALLOWED":
      return HttpStatus.CONFLICT;
    case "PROVIDER_ROUTE_UNAVAILABLE":
      return HttpStatus.SERVICE_UNAVAILABLE;
    case "PROVIDER_NOT_CONFIGURED":
      return HttpStatus.INTERNAL_SERVER_ERROR;
    case "PROVIDER_BROADCAST_FAILED":
    case "PROVIDER_HEALTHCHECK_FAILED":
    case "PROVIDER_STATUS_SYNC_FAILED":
      return HttpStatus.BAD_GATEWAY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch(CustodyError)
export class CustodyExceptionFilter implements ExceptionFilter {
  catch(exception: CustodyError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();

    response.status(mapCustodyErrorCodeToStatus(exception.code)).json({
      code: exception.code,
      message: exception.message
    });
  }
}
