import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus
} from "@nestjs/common";

import { BlockchainIndexerError } from "../domain/errors.js";

function mapErrorCode(code: BlockchainIndexerError["code"]): number {
  switch (code) {
    case "INVALID_CONFIRMATION_COUNT":
    case "INVALID_AMOUNT":
    case "INVALID_BLOCK_RANGE":
    case "INVALID_SCAN_RANGE":
    case "UNSUPPORTED_NETWORK":
      return HttpStatus.BAD_REQUEST;
    case "OBSERVATION_ALREADY_FINALIZED":
      return HttpStatus.CONFLICT;
    case "OBSERVATION_NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "EVM_RPC_NOT_CONFIGURED":
    case "WALLET_CONFIRM_FAILED":
    case "WALLET_QUERY_FAILED":
    case "EVM_RPC_FAILED":
      return HttpStatus.BAD_GATEWAY;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@Catch(BlockchainIndexerError)
export class BlockchainIndexerExceptionFilter implements ExceptionFilter {
  catch(exception: BlockchainIndexerError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();

    response.status(mapErrorCode(exception.code)).json({
      code: exception.code,
      message: exception.message
    });
  }
}
