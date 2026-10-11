import {
  ArgumentsHost,
  Catch,
  ExceptionFilter
} from "@nestjs/common";

import { OpsConsoleError } from "../domain/errors.js";

@Catch(OpsConsoleError)
export class OpsConsoleExceptionFilter implements ExceptionFilter {
  catch(exception: OpsConsoleError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();

    response.status(exception.statusCode).json({
      code: exception.code,
      message: exception.message
    });
  }
}
