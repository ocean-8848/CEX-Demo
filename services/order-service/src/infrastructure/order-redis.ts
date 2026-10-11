import { createClient, type RedisClientType } from "redis";

export function createOrderRedisClient(url: string): RedisClientType {
  return createClient({
    url
  });
}
