import { NextRequest } from "next/server";
import { getRedis, getUpstashRedisRest } from "@/lib/redis";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

function memoryRateLimit(
  request: NextRequest,
  options: { key: string; limit: number; windowMs: number }
) {
  const ip = getClientIp(request);
  const key = `${options.key}:${ip}`;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { ok: true, remaining: options.limit - 1, resetAt: now + options.windowMs };
  }

  if (existing.count >= options.limit) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return { ok: true, remaining: options.limit - existing.count, resetAt: existing.resetAt };
}

export async function rateLimit(
  request: NextRequest,
  options: { key: string; limit: number; windowMs: number }
) {
  const ip = getClientIp(request);
  const key = `rate:${options.key}:${ip}`;

  const upstash = getUpstashRedisRest();
  if (upstash) {
    try {
      const count = await upstash.incr(key);
      if (count === 1) await upstash.pexpire(key, options.windowMs);
      const ttl = await upstash.pttl(key);
      return {
        ok: count <= options.limit,
        remaining: Math.max(options.limit - count, 0),
        resetAt: Date.now() + Math.max(ttl, 0)
      };
    } catch {
      return memoryRateLimit(request, options);
    }
  }

  const redis = getRedis();
  if (!redis) return memoryRateLimit(request, options);

  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, options.windowMs);
    const ttl = await redis.pttl(key);
    return {
      ok: count <= options.limit,
      remaining: Math.max(options.limit - count, 0),
      resetAt: Date.now() + Math.max(ttl, 0)
    };
  } catch {
    return memoryRateLimit(request, options);
  }
}
