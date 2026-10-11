import type { RedisClientType } from "redis";

import type { RateLimitDecision, RateLimiter } from "../domain/types.js";
import { buildGatewayRedisKey } from "./gateway-redis.js";

const RATE_LIMIT_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisClientType,
    private readonly keyPrefix: string
  ) {}

  async consume(input: {
    key: string;
    limit: number;
    windowMs: number;
    now?: Date;
  }): Promise<RateLimitDecision> {
    const key = buildGatewayRedisKey(this.keyPrefix, "rate-limit", input.key);
    const result = (await this.client.eval(RATE_LIMIT_LUA, {
      keys: [key],
      arguments: [String(input.windowMs)]
    })) as [number | string, number | string];
    const count = Number(result[0] ?? 0);
    const ttlMs = Math.max(Number(result[1] ?? input.windowMs), 0);
    const now = input.now?.getTime() ?? Date.now();
    const resetAt = new Date(now + ttlMs).toISOString();

    if (count > input.limit) {
      return {
        allowed: false,
        limit: input.limit,
        remaining: 0,
        resetAt
      };
    }

    return {
      allowed: true,
      limit: input.limit,
      remaining: Math.max(input.limit - count, 0),
      resetAt
    };
  }
}
