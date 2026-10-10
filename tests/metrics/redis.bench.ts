import assert from "node:assert/strict";
import Redis from "ioredis";
import { NextRequest } from "next/server";
import { performance } from "node:perf_hooks";
import { rateLimit } from "../../lib/rate-limit";
import { getRedis } from "../../lib/redis";
import { add, integer, measure, percentage, summarize, type Context } from "./common";

export async function redisMetrics(context: Context) {
  const publisher = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
  const subscriberCount = integer("METRICS_REDIS_SUBSCRIBERS", 3, 1, 20);
  const subscribers = Array.from({ length: subscriberCount }, () => publisher.duplicate());
  const channel = "metrics:" + context.runId;
  const timings: number[] = [];
  let received = 0;
  try {
    await publisher.ping();
    await Promise.all(subscribers.map((subscriber) => subscriber.subscribe(channel)));
    for (let index = 0; index < context.warmup + context.samples; index++) {
      const id = context.runId + ":" + index;
      const start = performance.now();
      await Promise.all(subscribers.map((subscriber) => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { subscriber.off("message", listener); reject(new Error("Redis pub/sub delivery timed out")); }, 5000);
        const listener = (_channel: string, message: string) => {
          if (message !== id) return;
          clearTimeout(timeout); subscriber.off("message", listener);
          if (index >= context.warmup) { timings.push(performance.now() - start); received++; }
          resolve();
        };
        subscriber.on("message", listener);
      })).concat([publisher.publish(channel, id).then(() => {})]));
    }
    const expected = context.samples * subscriberCount;
    add(context, {
      id: "M05", name: "Redis pub/sub fan-out latency", component: "Redis",
      scope: context.metadata.hosted ? "production Redis, three benchmark subscribers on EC2" : "isolated Redis, subscribers on this benchmark host",
      status: received === expected ? "passed" : "failed",
      values: { deliveryMs: summarize(timings), publishers: 1, subscribers: subscriberCount,
        published: context.samples, expectedDeliveries: expected, received,
        deliveryPercent: percentage(received, expected) },
      samples: { subscriberDeliveryMs: timings },
      notes: ["Each sample is publisher enqueue through a subscriber callback; includes client/event-loop overhead. Subscriber deliveries from one publication are correlated."]
    });
  } finally { await Promise.allSettled([publisher.quit(), ...subscribers.map((subscriber) => subscriber.quit())]); }
}
export async function rateLimitMetrics(context: Context) {
  const redis = getRedis();
  assert.ok(redis);
  await redis.ping();
  const ip = "198.51.100.77";
  const key = "metrics:" + context.runId;
  const redisKey = "rate:" + key + ":" + ip;
  const limit = 20;
  let allowed = 0;
  let blocked = 0;
  try {
    const result = await measure(40, async () => {
      const decision = await rateLimit(new NextRequest("http://localhost/metrics", { headers: { "x-real-ip": ip } }), {
        key, limit, windowMs: 60_000
      });
      if (decision.ok) allowed++; else blocked++;
    }, context.concurrency);
    const storedCount = Number(await redis.get(redisKey));
    const ttlMs = await redis.pttl(redisKey);
    const { rawMs, ...timing } = result;
    const passed = allowed === limit && blocked === 20 && storedCount === 40 && ttlMs > 0 && !result.errors.length;
    add(context, {
      id: "M06", name: "Redis-backed burst rate-limit enforcement", component: "Redis / API rate limiter",
      scope: context.metadata.hosted ? "production Redis, dedicated run-owned rate bucket" : "real rateLimit helper, isolated Redis",
      status: passed ? "passed" : "failed",
      values: { ...timing, limit, burst: 40, allowed, blocked, overLimitRequests: 20,
        overLimitBlockedPercent: percentage(blocked, 20), backendCounter: storedCount, backendTtlMs: ttlMs,
        backendVerified: storedCount === 40 && ttlMs > 0, concurrency: context.concurrency },
      samples: { decisionMs: rawMs },
      notes: ["A fixed 40-request synthetic burst against a 20-request bucket, not a DDoS capacity claim. The Redis counter/TTL check detects silent in-memory fallback."]
    });
  } finally { await redis.del(redisKey); }
}
