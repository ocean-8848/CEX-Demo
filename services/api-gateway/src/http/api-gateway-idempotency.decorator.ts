import { SetMetadata } from "@nestjs/common";

export const API_GATEWAY_IDEMPOTENT_ROUTE_KEY = "api_gateway_idempotent_route";

export function GatewayIdempotentRoute() {
  return SetMetadata(API_GATEWAY_IDEMPOTENT_ROUTE_KEY, true);
}
