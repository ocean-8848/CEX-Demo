import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  CONTROL_SWITCH_HTTP_STATUS,
  CachedControlSwitchReader,
  createHttpControlSwitchLoader,
  evaluateApiWriteGate,
  evaluateWithdrawalGate,
  type ControlSwitchReader,
  type ControlSwitchState
} from "@web3-cex/domain";

import { ApiGatewayError } from "../domain/errors.js";

export const API_GATEWAY_CONTROLLED_WRITE_KEY = "api_gateway_controlled_write";

/** What a guarded write creates: a spot order, or a withdrawal (request / pre-check). */
export type ControlledWriteKind = "spot_order" | "withdrawal";

/**
 * Marks a write route that the emergency switches can block:
 * - `spot_order`: API write freeze → 409 API_WRITE_FROZEN
 * - `withdrawal`: global pause → 409 WITHDRAWALS_PAUSED, asset pause →
 *   409 ASSET_WITHDRAWALS_PAUSED, API write freeze → 409 API_WRITE_FROZEN
 * Cancels and reads are never marked, so they keep working.
 */
export function ControlledWrite(kind: ControlledWriteKind) {
  return SetMetadata(API_GATEWAY_CONTROLLED_WRITE_KEY, kind);
}

/**
 * Process-wide reader so the guard and the public `/system/controls` route
 * share one cache (`CONTROL_SWITCH_CACHE_MS`, default 2s).
 */
let sharedReader: ControlSwitchReader | null = null;
export function gatewayControlSwitchReader(): ControlSwitchReader {
  sharedReader ??= new CachedControlSwitchReader(
    createHttpControlSwitchLoader({
      baseUrl: process.env.GATEWAY_RISK_SERVICE_URL ?? "http://127.0.0.1:3008",
      callerName: "api-gateway"
    }),
    {
      cacheMs: Number(process.env.CONTROL_SWITCH_CACHE_MS ?? "2000"),
      onError: (error) =>
        console.warn(`[api-gateway] control switches unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  );
  return sharedReader;
}

/** Returns the rejection for a guarded write, or null when the write may proceed. */
export function evaluateControlledWrite(
  state: ControlSwitchState,
  kind: ControlledWriteKind,
  assetCode: string | undefined
) {
  if (kind === "withdrawal") {
    // Without an assetCode only the global pause can match; wallet-service
    // re-checks the asset after validating the request anyway.
    return evaluateWithdrawalGate(state, assetCode ?? "") ?? evaluateApiWriteGate(state);
  }
  return evaluateApiWriteGate(state);
}

@Injectable()
export class ApiGatewayControlSwitchGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<ControlledWriteKind | undefined>(
      API_GATEWAY_CONTROLLED_WRITE_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (!kind) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ body?: { assetCode?: unknown } }>();
    const assetCode = typeof request.body?.assetCode === "string" ? request.body.assetCode : undefined;
    const rejection = evaluateControlledWrite(await gatewayControlSwitchReader().getState(), kind, assetCode);
    if (rejection) {
      throw new ApiGatewayError(rejection.code, CONTROL_SWITCH_HTTP_STATUS, rejection.message);
    }
    return true;
  }
}
