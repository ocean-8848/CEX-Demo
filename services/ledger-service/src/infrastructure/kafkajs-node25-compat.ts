import { createRequire } from "node:module";

const CHECK_PENDING_REQUESTS_INTERVAL = 10;

type RequestQueueLike = {
  throttledUntil: number;
  pending: unknown[];
  throttleCheckTimeoutId: ReturnType<typeof setTimeout> | null;
  checkPendingRequests(): void;
};

type RequestQueueModule = {
  prototype: {
    scheduleCheckPendingRequests(this: RequestQueueLike): void;
  };
};

let kafkaJsNode25CompatApplied = false;

export function applyKafkaJsNode25CompatibilityPatch(): void {
  if (kafkaJsNode25CompatApplied) {
    return;
  }

  const require = createRequire(import.meta.url);
  const RequestQueue = require("kafkajs/src/network/requestQueue") as RequestQueueModule;

  if (typeof RequestQueue?.prototype?.scheduleCheckPendingRequests !== "function") {
    return;
  }

  RequestQueue.prototype.scheduleCheckPendingRequests = function scheduleCheckPendingRequestsPatched(
    this: RequestQueueLike
  ): void {
    if (this.throttleCheckTimeoutId) {
      return;
    }

    const throttleDelay = this.throttledUntil - Date.now();
    const hasPendingRequests = this.pending.length > 0;

    if (!hasPendingRequests && throttleDelay <= 0) {
      return;
    }

    const scheduleAt = hasPendingRequests
      ? throttleDelay > 0
        ? throttleDelay
        : CHECK_PENDING_REQUESTS_INTERVAL
      : throttleDelay;

    this.throttleCheckTimeoutId = setTimeout(() => {
      this.throttleCheckTimeoutId = null;
      this.checkPendingRequests();
    }, scheduleAt);
  };

  kafkaJsNode25CompatApplied = true;
}
