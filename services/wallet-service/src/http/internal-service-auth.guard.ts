import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import {
  INTERNAL_SERVICE_DEFAULT_MAX_SKEW_MS,
  isInternalServiceTimestampFresh,
  readInternalServiceAuthHeaders,
  verifyInternalServiceSignature
} from "@web3-cex/domain";

const DEFAULT_ALLOWED_CALLERS = [
  "api-gateway",
  "blockchain-indexer",
  // new-device login notifications (security.new_device_login)
  "identity-service",
  "ops-console",
  "demo-scripts"
];

@Injectable()
export class InternalServiceAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.INTERNAL_SERVICE_AUTH_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException("INTERNAL_SERVICE_AUTH_SECRET is not configured");
    }

    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl: string;
      rawBody?: Buffer;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const headers = readInternalServiceAuthHeaders(request.headers);

    if (!headers) {
      throw new UnauthorizedException("Missing internal service authentication headers");
    }

    const allowedCallers = readAllowedCallers(DEFAULT_ALLOWED_CALLERS);
    if (!allowedCallers.has(headers.callerName)) {
      throw new UnauthorizedException(`Caller ${headers.callerName} is not allowed`);
    }

    if (
      !isInternalServiceTimestampFresh({
        timestamp: headers.timestamp,
        maxSkewMs: readMaxSkewMs()
      })
    ) {
      throw new UnauthorizedException("Internal service request timestamp is stale");
    }

    const valid = verifyInternalServiceSignature({
      secret,
      callerName: headers.callerName,
      method: request.method,
      path: request.originalUrl,
      timestamp: headers.timestamp,
      rawBody: request.rawBody,
      signature: headers.signature
    });

    if (!valid) {
      throw new UnauthorizedException("Internal service request signature is invalid");
    }

    return true;
  }
}

function readAllowedCallers(fallback: string[]): Set<string> {
  const configured = process.env.INTERNAL_SERVICE_ALLOWED_CALLERS;
  if (!configured) {
    return new Set(fallback);
  }

  return new Set(
    configured
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
}

function readMaxSkewMs(): number {
  const configured = Number(process.env.INTERNAL_SERVICE_AUTH_MAX_SKEW_MS ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : INTERNAL_SERVICE_DEFAULT_MAX_SKEW_MS;
}
