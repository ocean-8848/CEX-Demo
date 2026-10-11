import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { applyKafkaJsNode25CompatibilityPatch } from "../infrastructure/kafkajs-node25-compat.js";

type RequestQueueLike = {
  throttledUntil: number;
  pending: unknown[];
  throttleCheckTimeoutId: ReturnType<typeof setTimeout> | null;
  checkPendingRequests(): void;
};

const require = createRequire(import.meta.url);

function loadRequestQueue() {
  return require("kafkajs/src/network/requestQueue") as {
    prototype: { scheduleCheckPendingRequests(this: RequestQueueLike): void };
  };
}

test("KafkaJS Node 25 compatibility patch skips negative timeout scheduling when queue is idle", () => {
  applyKafkaJsNode25CompatibilityPatch();

  let scheduledDelay: number | undefined;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    scheduledDelay = Number(delay);
    return {
      ref() {
        return this;
      },
      unref() {
        return this;
      }
    } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const queue: RequestQueueLike = {
      throttledUntil: 0,
      pending: [],
      throttleCheckTimeoutId: null,
      checkPendingRequests() {
        throw new Error("checkPendingRequests should not be called");
      }
    };

    const RequestQueue = loadRequestQueue();

    RequestQueue.prototype.scheduleCheckPendingRequests.call(queue);

    assert.equal(scheduledDelay, undefined);
    assert.equal(queue.throttleCheckTimeoutId, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("KafkaJS Node 25 compatibility patch preserves pending-request polling", () => {
  applyKafkaJsNode25CompatibilityPatch();

  let scheduledDelay: number | undefined;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    scheduledDelay = Number(delay);
    return {
      ref() {
        return this;
      },
      unref() {
        return this;
      }
    } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const queue: RequestQueueLike = {
      throttledUntil: 0,
      pending: [{}],
      throttleCheckTimeoutId: null,
      checkPendingRequests() {
        throw new Error("checkPendingRequests should not be called");
      }
    };

    const RequestQueue = loadRequestQueue();

    RequestQueue.prototype.scheduleCheckPendingRequests.call(queue);

    assert.equal(scheduledDelay, 10);
    assert.notEqual(queue.throttleCheckTimeoutId, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
