import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException
} from "@nestjs/common";

import { ApiGatewayError } from "../domain/errors.js";

@Catch()
export class ApiGatewayExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: Record<string, unknown>): void };
    }>();

    if (exception instanceof ApiGatewayError) {
      response.status(exception.statusCode).json({
        code: exception.code,
        message: exception.message
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        message: exception.message
      });
      return;
    }

    response.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: exception instanceof Error ? exception.message : "Unknown gateway error"
    });
  }
}
