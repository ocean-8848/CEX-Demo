import { isStopOrderType, isStpMode, type StpMode } from "@web3-cex/domain";

import { ApiGatewayError } from "../domain/errors.js";

/**
 * Shape checks for the matching options of a new order (post-only, STP mode,
 * stop trigger). Business rules (GTC-only post-only, trigger deviation band,
 * funds) are enforced by risk-service; the gateway only rejects malformed
 * input early and normalizes JSON quirks such as `"postOnly": "true"`.
 */
export function normalizeOrderOptions<
  T extends { type: string; postOnly?: unknown; stpMode?: unknown; triggerPrice?: unknown }
>(command: T): Omit<T, "postOnly" | "stpMode" | "triggerPrice"> & {
  postOnly?: boolean;
  stpMode?: StpMode;
  triggerPrice?: string;
} {
  const { postOnly, stpMode, triggerPrice, ...rest } = command;

  if (postOnly !== undefined && typeof postOnly !== "boolean" && postOnly !== "true" && postOnly !== "false") {
    throw new ApiGatewayError("INVALID_POST_ONLY", 400, "postOnly must be a boolean");
  }
  if (stpMode !== undefined && stpMode !== null && stpMode !== "" && !isStpMode(stpMode)) {
    throw new ApiGatewayError(
      "INVALID_STP_MODE",
      400,
      "stpMode must be one of expire_taker, expire_maker, expire_both"
    );
  }
  if (triggerPrice !== undefined && triggerPrice !== null && triggerPrice !== "" && typeof triggerPrice !== "string") {
    throw new ApiGatewayError("INVALID_TRIGGER_PRICE", 400, "triggerPrice must be a decimal string");
  }
  if (isStopOrderType(command.type) && (typeof triggerPrice !== "string" || triggerPrice.trim() === "")) {
    throw new ApiGatewayError("TRIGGER_PRICE_REQUIRED", 400, "stop_limit / stop_market orders require triggerPrice");
  }

  return {
    ...rest,
    ...(postOnly === true || postOnly === "true" ? { postOnly: true } : {}),
    ...(isStpMode(stpMode) ? { stpMode } : {}),
    ...(typeof triggerPrice === "string" && triggerPrice.trim() !== "" ? { triggerPrice: triggerPrice.trim() } : {})
  };
}
