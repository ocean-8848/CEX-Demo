import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";

import { TreasuryError, treasuryErrorStatus } from "../domain/treasury-errors.js";

@Catch(TreasuryError)
export class TreasuryExceptionFilter implements ExceptionFilter {
  catch(exception: TreasuryError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(payload: unknown): void };
    }>();
    response.status(treasuryErrorStatus(exception.code)).json({
      code: exception.code,
      message: exception.message
    });
  }
}
