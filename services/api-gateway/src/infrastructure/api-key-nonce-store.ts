import type { RedisClientType } from "redis";

import type { NonceStore } from "../domain/types.js";
import { buildGatewayRedisKey } from "./gateway-redis.js";

/** SET NX with a TTL: the first request with a nonce wins, replays are rejected. */
export class RedisNonceStore implements NonceStore {
  constructor(
    private readonly client: RedisClientType,
    private readonly keyPrefix: string
  ) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(buildGatewayRedisKey(this.keyPrefix, "api-key-nonce", key), "1", {
      NX: true,
      PX: ttlMs
    });
    return result === "OK";
  }
}

export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();

  async claim(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    for (const [entry, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(entry);
      }
    }
    if (this.entries.has(key)) {
      return false;
    }
    this.entries.set(key, now + ttlMs);
    return true;
  }
}
