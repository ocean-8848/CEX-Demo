import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";

import { OrderServiceError } from "../domain/errors.js";

@Catch()
export class OrderExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (statusCode: number) => { json: (body: unknown) => void };
    }>();

    if (exception instanceof OrderServiceError) {
      response.status(exception.statusCode).json({
        code: exception.code,
        message: exception.message
      });
      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json({
        code: "HTTP_EXCEPTION",
        message: exception.message
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "INTERNAL_SERVER_ERROR",
      message: exception instanceof Error ? exception.message : "unknown order error"
    });
  }
}
