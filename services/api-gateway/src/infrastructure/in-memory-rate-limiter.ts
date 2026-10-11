import type { RateLimitDecision, RateLimiter } from "../domain/types.js";

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  async consume(input: {
    key: string;
    limit: number;
    windowMs: number;
    now?: Date;
  }): Promise<RateLimitDecision> {
    const now = input.now?.getTime() ?? Date.now();
    const existing = this.buckets.get(input.key);

    let bucket: Bucket;
    if (!existing || existing.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + input.windowMs
      };
    } else {
      bucket = existing;
    }

    if (bucket.count >= input.limit) {
      this.buckets.set(input.key, bucket);
      return {
        allowed: false,
        limit: input.limit,
        remaining: 0,
        resetAt: new Date(bucket.resetAt).toISOString()
      };
    }

    bucket.count += 1;
    this.buckets.set(input.key, bucket);

    return {
      allowed: true,
      limit: input.limit,
      remaining: Math.max(input.limit - bucket.count, 0),
      resetAt: new Date(bucket.resetAt).toISOString()
    };
  }
}
