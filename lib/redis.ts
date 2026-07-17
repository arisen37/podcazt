import Redis from "ioredis";
import { getOptionalEnv } from "@/lib/env";

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
};

export function getRedis() {
  const url = getOptionalEnv("REDIS_URL");
  if (url && !url.startsWith("redis://") && !url.startsWith("rediss://")) {
    return null;
  }
  if (!url) return null;

  if (!globalForRedis.redis) {
    globalForRedis.redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: true
    });
  }

  return globalForRedis.redis;
}

type UpstashCommandResult<T> = {
  result?: T;
  error?: string;
};

export function getUpstashRedisRest() {
  const url = getOptionalEnv("UPSTASH_REDIS_REST_URL")?.replace(/\/$/, "");
  const token = getOptionalEnv("UPSTASH_REDIS_REST_TOKEN");

  if (!url || !token) return null;
  const restUrl = url;
  const restToken = token;

  async function command<T>(args: Array<string | number>) {
    const response = await fetch(restUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${restToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(args),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Upstash Redis request failed with status ${response.status}`);
    }

    const body = (await response.json()) as UpstashCommandResult<T>;
    if (body.error) throw new Error(body.error);
    return body.result as T;
  }

  return {
    incr: (key: string) => command<number>(["INCR", key]),
    pexpire: (key: string, milliseconds: number) => command<number>(["PEXPIRE", key, milliseconds]),
    pttl: (key: string) => command<number>(["PTTL", key])
  };
}
