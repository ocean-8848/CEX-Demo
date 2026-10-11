import { Logger } from "@nestjs/common";

export class ConsoleGatewayAuditLogger {
  private readonly logger = new Logger("ApiGatewayAudit");

  log(entry: Record<string, unknown>): void {
    this.logger.log(JSON.stringify(entry));
  }
}
