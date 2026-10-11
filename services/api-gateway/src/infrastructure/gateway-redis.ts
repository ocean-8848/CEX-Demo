import { createClient, type RedisClientType } from "redis";

export function createGatewayRedisClient(redisUrl: string): RedisClientType {
  return createClient({
    url: redisUrl
  });
}

export function buildGatewayRedisKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].join(":");
}
