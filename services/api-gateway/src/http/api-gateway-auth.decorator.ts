import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata
} from "@nestjs/common";

import type { ApiKeyScope, GatewayAuthMode, GatewayPrincipal } from "../domain/types.js";

export const API_GATEWAY_AUTH_MODE_KEY = "api_gateway_auth_mode";
export const API_GATEWAY_API_KEY_SCOPE_KEY = "api_gateway_api_key_scope";

/**
 * Scope an API key needs for this route. Without it, GET routes need "read"
 * and every other method needs "trade".
 */
export function RequireApiKeyScope(scope: ApiKeyScope) {
  return SetMetadata(API_GATEWAY_API_KEY_SCOPE_KEY, scope);
}

export function GatewayAuthMode(mode: GatewayAuthMode) {
  return SetMetadata(API_GATEWAY_AUTH_MODE_KEY, mode);
}

export function PublicGatewayRoute() {
  return GatewayAuthMode("public");
}

export function SessionOnlyRoute() {
  return GatewayAuthMode("session");
}

export function SessionOrApiKeyRoute() {
  return GatewayAuthMode("session_or_api_key");
}

export const CurrentGatewayAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): GatewayPrincipal | undefined => {
    const request = context.switchToHttp().getRequest<{ gatewayAuth?: GatewayPrincipal }>();
    return request.gatewayAuth;
  }
);
