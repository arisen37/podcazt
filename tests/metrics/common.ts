import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "../../lib/types";

export type Summary = {
  count: number; min: number | null; mean: number | null;
  p50: number | null; p95: number | null; p99: number | null; max: number | null;
};
export function summarize(values: number[]): Summary {
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0), "samples must be finite and nonnegative");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    count: values.length, min: sorted[0] ?? null,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99),
    max: sorted.at(-1) ?? null
  };
}
export function percentage(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator * 100 : null;
}
export type Metric = {
  id: string; name: string; component: string; scope: string;
  status: "passed" | "failed" | "unavailable";
  values: Record<string, unknown>;
  samples?: Record<string, number[]>;
  notes?: string[];
};
export type Fixture = {
  owner: SessionUser; member: SessionUser; outsider: SessionUser;
  roomIds: string[]; closedRoomId: string; missingRoomId: string;
};
export type Context = {
  runId: string; samples: number; warmup: number; concurrency: number;
  fixtureRows: number; mediaSeconds: number; mediaRuns: number;
  httpUrl: string; webUrl: string; signalingUrl: string;
  ca?: Buffer; prisma?: PrismaClient; fixture?: Fixture;
  realtimeTokens?: Record<string, string>;
  iceServers?: RTCIceServer[]; forceRelay?: boolean;
  peerIceServers?: RTCIceServer[][];
  registerFixture?: (fixture: Fixture) => void;
  results: Metric[]; metadata: Record<string, unknown>;
};
export function add(context: Context, metric: Metric) {
  assert.ok(!context.results.some((item) => item.id === metric.id), "duplicate metric ID");
  context.results.push(metric);
  console.log(metric.id + " " + metric.name + ": " + metric.status);
}
export async function measure(samples: number, operation: (index: number) => Promise<void>, concurrency = 1) {
  const timings: number[] = [];
  const errors: Array<{ index: number; message: string }> = [];
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, samples) }, async () => {
    while (next < samples) {
      const index = next++;
      const before = performance.now();
      try {
        await operation(index);
        timings.push(performance.now() - before);
      } catch (error) {
        errors.push({ index, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }));
  const elapsedMs = performance.now() - start;
  return {
    latencyMs: summarize(timings), successful: timings.length, attempted: samples,
    errors, errorPercent: percentage(errors.length, samples),
    elapsedMs, successfulPerSecond: timings.length / (elapsedMs / 1000), rawMs: timings
  };
}
export async function warmup(count: number, operation: () => Promise<unknown>) {
  for (let index = 0; index < count; index++) await operation();
}
export async function until(check: () => Promise<boolean>, label: string, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error("Timed out waiting for " + label);
}
export function requiredFixture(context: Context) {
  assert.ok(context.fixture, "database fixtures were not prepared");
  return { fixture: context.fixture, prisma: context.prisma };
}
export function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value >= min && value <= max, name + " must be between " + min + " and " + max);
  return value;
}
