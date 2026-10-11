import type { RedisClientType } from "redis";

import type { IdempotencyReplay, IdempotencyStore } from "../domain/types.js";
import { buildGatewayRedisKey } from "./gateway-redis.js";

interface StoredValue {
  requestFingerprint: string;
  state: "in_progress" | "completed";
  statusCode?: number;
  responseBody?: string;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly client: RedisClientType,
    private readonly keyPrefix: string
  ) {}

  async begin(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
    ttlMs: number;
    now?: Date;
  }): Promise<IdempotencyReplay> {
    const key = this.buildKey(input.scopeKey, input.idempotencyKey);
    const payload: StoredValue = {
      requestFingerprint: input.requestFingerprint,
      state: "in_progress"
    };
    const created = await this.client.set(key, JSON.stringify(payload), {
      NX: true,
      PX: input.ttlMs
    });

    if (created === "OK") {
      return {
        outcome: "acquired"
      };
    }

    const raw = await this.client.get(key);
    if (!raw) {
      const retried = await this.client.set(key, JSON.stringify(payload), {
        NX: true,
        PX: input.ttlMs
      });
      return {
        outcome: retried === "OK" ? "acquired" : "in_flight"
      };
    }

    const existing = parseStoredValue(raw);
    if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
      return {
        outcome: "conflict"
      };
    }

    if (existing.state === "completed") {
      return {
        outcome: "replay",
        statusCode: existing.statusCode,
        responseBody: existing.responseBody
      };
    }

    return {
      outcome: "in_flight"
    };
  }

  async complete(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
    statusCode: number;
    responseBody: string;
    ttlMs: number;
    now?: Date;
  }): Promise<void> {
    const key = this.buildKey(input.scopeKey, input.idempotencyKey);
    const current = await this.client.get(key);
    const existing = current ? parseStoredValue(current) : undefined;

    if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
      return;
    }

    await this.client.set(
      key,
      JSON.stringify({
        requestFingerprint: input.requestFingerprint,
        state: "completed",
        statusCode: input.statusCode,
        responseBody: input.responseBody
      } satisfies StoredValue),
      {
        PX: input.ttlMs
      }
    );
  }

  async abort(input: {
    scopeKey: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<void> {
    const key = this.buildKey(input.scopeKey, input.idempotencyKey);
    const current = await this.client.get(key);
    const existing = current ? parseStoredValue(current) : undefined;

    if (existing?.requestFingerprint === input.requestFingerprint) {
      await this.client.del(key);
    }
  }

  private buildKey(scopeKey: string, idempotencyKey: string): string {
    return buildGatewayRedisKey(this.keyPrefix, "idempotency", scopeKey, idempotencyKey);
  }
}

function parseStoredValue(raw: string): StoredValue | undefined {
  try {
    return JSON.parse(raw) as StoredValue;
  } catch {
    return undefined;
  }
}
