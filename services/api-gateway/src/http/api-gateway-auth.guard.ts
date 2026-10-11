import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { ApiKeyScope, GatewayAuthMode, GatewayPrincipal } from "../domain/types.js";
import {
  API_GATEWAY_API_KEY_SCOPE_KEY,
  API_GATEWAY_AUTH_MODE_KEY
} from "./api-gateway-auth.decorator.js";
import { ApiGatewayHttpService } from "./api-gateway-http.service.js";

@Injectable()
export class ApiGatewayAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiGatewayHttpService: ApiGatewayHttpService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const mode =
      this.reflector.getAllAndOverride<GatewayAuthMode>(API_GATEWAY_AUTH_MODE_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? "session_or_api_key";

    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl: string;
      rawBody?: Buffer;
      headers: Record<string, string | string[] | undefined>;
      gatewayAuth?: GatewayPrincipal;
    }>();

    if (mode === "public") {
      return true;
    }

    const bearerToken = parseBearerToken(request.headers.authorization);
    if (mode === "session") {
      if (!bearerToken) {
        throw new UnauthorizedException("Customer session token is required");
      }

      request.gatewayAuth = await this.apiGatewayHttpService.authenticateCustomerSession(
        bearerToken
      );
      return true;
    }

    if (bearerToken) {
      request.gatewayAuth = await this.apiGatewayHttpService.authenticateCustomerSession(
        bearerToken
      );
      return true;
    }

    const signatureHeaders = readApiKeyHeaders(request.headers);
    if (!signatureHeaders) {
      throw new UnauthorizedException(
        "Missing customer session token or API key signature headers"
      );
    }

    const principal = await this.apiGatewayHttpService.authenticateApiKey({
      apiKey: signatureHeaders.apiKey,
      timestamp: signatureHeaders.timestamp,
      nonce: signatureHeaders.nonce,
      signature: signatureHeaders.signature,
      method: request.method,
      url: request.originalUrl,
      rawBody: request.rawBody
    });
    const requiredScope =
      this.reflector.getAllAndOverride<ApiKeyScope>(API_GATEWAY_API_KEY_SCOPE_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? (request.method.toUpperCase() === "GET" ? "read" : "trade");
    this.apiGatewayHttpService.assertApiKeyScope(principal, requiredScope);
    request.gatewayAuth = principal;
    return true;
  }
}

function parseBearerToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header || !header.startsWith("Bearer ")) {
    return undefined;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function readApiKeyHeaders(headers: Record<string, string | string[] | undefined>) {
  const apiKey = readHeader(headers, "x-api-key");
  const timestamp = readHeader(headers, "x-api-timestamp");
  const nonce = readHeader(headers, "x-api-nonce");
  const signature = readHeader(headers, "x-api-signature");

  if (!apiKey && !timestamp && !nonce && !signature) {
    return undefined;
  }

  if (!apiKey || !timestamp || !nonce || !signature) {
    throw new UnauthorizedException(
      "X-API-Key, X-API-Timestamp, X-API-Nonce and X-API-Signature must all be provided"
    );
  }

  return {
    apiKey,
    timestamp,
    nonce,
    signature
  };
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
