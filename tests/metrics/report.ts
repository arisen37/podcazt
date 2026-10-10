import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Metric, Context } from "./common";

export const primaryValues: Record<string, [string, string]> = {
  M01: ["latencyMs.p95", "ms"], M02: ["handshakeMs.p95", "ms"], M03: ["latencyMs.p95", "ms"],
  M04: ["negativeCaseRejectionPercent", "%"], M05: ["deliveryMs.p95", "ms"],
  M06: ["overLimitBlockedPercent", "%"], M07: ["latencyMs.p95", "ms"], M08: ["joinMs.p95", "ms"],
  M09: ["latencyMs.p95", "ms"], M10: ["usefulPayloadMbitPerSecond", "Mbit/s"],
  M11: ["setupMs.p95", "ms"], M12: ["rttMs.p95", "ms"], M13: ["packetLossPercent", "%"],
  M14: ["decodeDropPercent", "%"], M15: ["recoveryMs.p95", "ms"]
};
export function field(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function evaluateBudgets(metrics: Metric[], budgets: unknown) {
  assert.ok(budgets && typeof budgets === "object" && !Array.isArray(budgets), "budgets must be an object");
  const checks: Array<{ metric: string; path: string; actual: number | null; min?: number; max?: number; passed: boolean }> = [];
  for (const [id, rules] of Object.entries(budgets)) {
    assert.ok(primaryValues[id], "Unknown budget metric: " + id);
    assert.ok(rules && typeof rules === "object" && !Array.isArray(rules), "Invalid budget rules: " + id);
    const metric = metrics.find((item) => item.id === id);
    if (!metric) continue; // A subset run evaluates only selected metrics.
    for (const [path, limits] of Object.entries(rules)) {
      assert.ok(limits && typeof limits === "object" && !Array.isArray(limits), "Invalid limit: " + id + "." + path);
      const rule = limits as { min?: number; max?: number };
      assert.ok(Object.keys(rule).every((key) => key === "min" || key === "max"), "Only min/max budget keys are accepted");
      assert.ok(rule.min !== undefined || rule.max !== undefined, "Specify min or max");
      for (const limit of [rule.min, rule.max]) assert.ok(limit === undefined || Number.isFinite(limit), "Budget limits must be finite");
      assert.ok(rule.min === undefined || rule.max === undefined || rule.min <= rule.max, "Budget min exceeds max");
      const value = field(metric.values, path);
      const numeric = typeof value === "number" && Number.isFinite(value);
      const actual = numeric ? value as number : null;
      checks.push({ metric: id, path, actual, ...rule,
        passed: metric.status === "passed" && actual !== null &&
          (rule.min === undefined || actual >= rule.min) && (rule.max === undefined || actual <= rule.max) });
    }
  }
  return checks;
}
export function saveReport(context: Context, startedAt: string, finishedAt: string, budgetChecks: ReturnType<typeof evaluateBudgets>) {
  const report = {
    schemaVersion: 1, runId: context.runId, startedAt, finishedAt,
    configuration: { samples: context.samples, warmup: context.warmup, concurrency: context.concurrency,
      fixtureRows: context.fixtureRows, mediaRuns: context.mediaRuns, mediaSeconds: context.mediaSeconds,
      uploadParts: Number(process.env.METRICS_UPLOAD_PARTS ?? 6), uploadPartBytes: 8 * 1024 * 1024,
      redisSubscribers: context.metadata.hosted ? 3 : Number(process.env.METRICS_REDIS_SUBSCRIBERS ?? 3),
      rateLimit: { limit: 20, burst: 40 }, injectedUploadFailures: 1 },
    environment: context.metadata, metrics: context.results.sort((a, b) => a.id.localeCompare(b.id)), budgetChecks
  };
  const directory = resolve("artifacts/metrics");
  mkdirSync(directory, { recursive: true });
  const basename = startedAt.replaceAll(":", "-");
  const json = JSON.stringify(report, null, 2) + "\n";
  const lines = ["# Podcazt measured metrics", "", "Run: " + context.runId,
    "Started: " + startedAt, "", "These values describe this report's exact workload and environment.",
    "No performance targets are substituted for observations.", "",
    "| ID | Component / metric | Measured primary value | Status |",
    "| --- | --- | --- | --- |"];
  for (const metric of report.metrics) {
    const [path, unit] = primaryValues[metric.id];
    const value = field(metric.values, path);
    const rendered = typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) + " " + unit : "unavailable";
    lines.push("| " + metric.id + " | " + metric.component + ": " + metric.name + " | " + rendered + " | " + metric.status + " |");
  }
  lines.push("", "## Environment and workload", "", "~~~json", JSON.stringify({
    configuration: report.configuration, environment: report.environment
  }, null, 2), "~~~", "", "## Measurement scope", "");
  for (const metric of report.metrics) {
    lines.push("### " + metric.id + " " + metric.name, "", metric.scope, "",
      ...(metric.notes ?? []).map((note) => "- " + note), "");
  }
  if (budgetChecks.length) lines.push("## Optional budget checks", "", "~~~json", JSON.stringify(budgetChecks, null, 2), "~~~", "");
  const markdown = lines.join("\n") + "\n";
  for (const name of [basename, "latest"]) {
    writeFileSync(resolve(directory, name + ".json"), json, { mode: 0o600 });
    writeFileSync(resolve(directory, name + ".md"), markdown, { mode: 0o600 });
  }
  return resolve(directory, basename + ".json");
}
