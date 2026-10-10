import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { join, resolve } from "node:path";
import { add, integer, until, type Context } from "./common";
import { evaluateBudgets, saveReport } from "./report";

const groups: Record<string, { ids: string[]; module: string; fn: string }> = {
  http: { ids: ["M01"], module: "./http.bench", fn: "httpMetrics" },
  tls: { ids: ["M02"], module: "./http.bench", fn: "tlsMetrics" },
  auth: { ids: ["M03"], module: "./security.bench", fn: "authMetrics" },
  security: { ids: ["M04"], module: "./security.bench", fn: "securityMetrics" },
  redis: { ids: ["M05"], module: "./redis.bench", fn: "redisMetrics" },
  "rate-limit": { ids: ["M06"], module: "./redis.bench", fn: "rateLimitMetrics" },
  database: { ids: ["M07"], module: "./database.bench", fn: "databaseMetrics" },
  signaling: { ids: ["M08", "M09"], module: "./signaling.bench", fn: "signalingMetrics" },
  upload: { ids: ["M10"], module: "./upload.bench", fn: "uploadMetrics" },
  webrtc: { ids: ["M11", "M12", "M13", "M14", "M15"], module: "./webrtc.bench", fn: "webrtcMetrics" }
};
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/([a-z]+:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]");
}
async function freePort(port: number) {
  const probe = net.createServer();
  await new Promise<void>((accept, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", accept); });
  await new Promise<void>((accept) => probe.close(() => accept()));
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((accept) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
    child.once("exit", () => { clearTimeout(timer); accept(); });
    child.kill("SIGTERM");
  });
}
async function main() {
  let selected = Object.keys(groups);
  for (const arg of process.argv.slice(2)) {
    assert.ok(arg.startsWith("--only="), "Usage: npm run metrics -- --only=http,tls,auth,security,redis,rate-limit,database,signaling,upload,webrtc");
    selected = arg.slice("--only=".length).split(",");
    assert.ok(selected.length && selected.every((group) => groups[group]), "Unknown metric group");
    assert.equal(new Set(selected).size, selected.length, "Repeated metric group");
  }
  const databaseUrl = process.env.METRICS_DATABASE_URL || "postgresql://metrics:metrics-local-only@127.0.0.1:55432/podcazt_metrics?connection_limit=5";
  assert.equal(new URL(databaseUrl).pathname, "/podcazt_metrics", "Use a dedicated database named podcazt_metrics; production DATABASE_URL is never used");
  const redisUrl = process.env.METRICS_REDIS_URL || "redis://:metrics-local-only@127.0.0.1:56379/0";
  Object.assign(process.env, {
    NODE_ENV: "production", DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
    SESSION_SECRET: randomBytes(32).toString("hex"), SIGNALING_INTERNAL_SECRET: randomBytes(32).toString("hex"),
    UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", SESSION_SECRET_PREVIOUS: "",
    STORAGE_PROVIDER: "s3", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "",
    AWS_EC2_METADATA_DISABLED: "true", TURN_HOST: "", TURN_SHARED_SECRET: "", METERED_TURN_API_KEY: "",
    GOOGLE_EMAIL: "", GOOGLE_APP_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", SINGLE_INSTANCE_SIGNALING: "false"
  });
  const webPort = integer("METRICS_WEB_PORT", 4330, 1024, 65535);
  const signalPort = integer("METRICS_SIGNALING_PORT", 4430, 1024, 65535);
  assert.notEqual(webPort, signalPort);
  const startedAt = new Date().toISOString();
  const temporary = mkdtempSync(join(os.tmpdir(), "podcazt-metrics-"));
  const context: Context = {
    runId: "m-" + randomBytes(8).toString("hex"),
    samples: integer("METRICS_SAMPLES", 100, 1, 10_000), warmup: integer("METRICS_WARMUP", 10, 0, 1000),
    concurrency: integer("METRICS_CONCURRENCY", 4, 1, 64),
    fixtureRows: integer("METRICS_DB_ROOMS", 5000, 1, 100_000),
    mediaSeconds: integer("METRICS_MEDIA_SECONDS", 10, 3, 300), mediaRuns: integer("METRICS_MEDIA_RUNS", 3, 1, 50),
    httpUrl: process.env.METRICS_HTTP_URL || "",
    webUrl: "http://127.0.0.1:" + webPort, signalingUrl: "ws://127.0.0.1:" + signalPort,
    ca: process.env.METRICS_TLS_CA_FILE ? readFileSync(process.env.METRICS_TLS_CA_FILE) : undefined,
    results: [], metadata: {
      label: process.env.METRICS_HOST_LABEL || "local benchmark host",
      node: process.version, os: os.platform(), osRelease: os.release(), arch: os.arch(),
      cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
      hostLoadAtStart: os.loadavg(), gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
      nextBuildId: existsSync(".next/BUILD_ID") ? readFileSync(".next/BUILD_ID", "utf8").trim() : null,
      percentileMethod: "nearest rank; successful samples only, with errors reported separately",
      selectedGroups: selected
    }
  };
  const children: ChildProcess[] = [];
  const logs: ReturnType<typeof createWriteStream>[] = [];
  let proxy: https.Server | undefined;
  let aborted = false;
  const abort = () => { aborted = true; for (const child of children) child.kill("SIGTERM"); };
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const startChild = async (name: string, args: string[], port: number) => {
    await freePort(port);
    const log = createWriteStream(join(temporary, name + ".log"), { mode: 0o600 });
    logs.push(log);
    await once(log, "open");
    const child = spawn(process.execPath, args, { env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(webPort), SIGNALING_PORT: String(signalPort) }, stdio: ["ignore", log, log] });
    children.push(child);
    await until(async () => {
      if (aborted || child.exitCode !== null || child.signalCode !== null) throw new Error(name + " exited; see " + join(temporary, name + ".log"));
      return fetch("http://127.0.0.1:" + port + (name === "web" ? "/api/health" : "/health"), { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok).catch(() => false);
    }, name + " startup", 45_000);
  };
  const needsDb = selected.some((group) => ["auth", "security", "database", "signaling", "webrtc"].includes(group));
  const needsWeb = selected.includes("security") || (!context.httpUrl && selected.some((group) => group === "http" || group === "tls"));
  let setupFailed = false;
  let budgetChecks: ReturnType<typeof evaluateBudgets> = [];
  try {
    if (needsDb) {
      execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      const { seed } = await import("./database.bench");
      await seed(context);
    }
    if (needsWeb) {
      assert.ok(existsSync(".next/BUILD_ID"), "Run npm run build first, or use npm run metrics:local");
      await startChild("web", ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(webPort)], webPort);
    }
    if (selected.some((group) => group === "signaling" || group === "webrtc")) {
      await startChild("signaling", ["--import", "tsx", "server/signaling.ts"], signalPort);
    }
    if (!context.httpUrl && selected.some((group) => group === "http" || group === "tls")) {
      const cert = join(temporary, "cert.pem"); const key = join(temporary, "key.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
        "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
      context.ca = readFileSync(cert);
      proxy = https.createServer({ key: readFileSync(key), cert: context.ca, minVersion: "TLSv1.2" }, (incoming, outgoing) => {
        const upstream = http.request(new URL(incoming.url ?? "/", context.webUrl), { method: incoming.method, headers: incoming.headers }, (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
        });
        upstream.on("error", () => { outgoing.writeHead(502).end("Fixture upstream unavailable"); });
        incoming.pipe(upstream);
      });
      await new Promise<void>((accept) => proxy!.listen(0, "127.0.0.1", accept));
      const address = proxy.address();
      assert.ok(address && typeof address !== "string");
      context.httpUrl = "https://127.0.0.1:" + address.port;
      context.metadata.httpTopology = "local Node TLS fixture proxy -> local Next.js production server; not deployed Nginx";
    }
    if (context.httpUrl) {
      const target = new URL(context.httpUrl);
      assert.ok(["http:", "https:"].includes(target.protocol) && !target.username && !target.password && !target.search, "Use an HTTP(S) origin without credentials/query");
      context.metadata.httpTarget = target.origin;
    }
    for (const group of selected) {
      if (aborted) throw new Error("Metrics run interrupted");
      const spec = groups[group];
      try {
        const benchmarkModule = await import(spec.module);
        await benchmarkModule[spec.fn](context);
      } catch (error) {
        for (const id of spec.ids.filter((id) => !context.results.some((item) => item.id === id))) {
          add(context, { id, name: group + " benchmark", component: group, scope: "failed benchmark setup/execution",
            status: "failed", values: { error: safeError(error) } });
        }
      }
    }
    if (process.env.METRICS_BUDGET_FILE) budgetChecks = evaluateBudgets(context.results, JSON.parse(readFileSync(process.env.METRICS_BUDGET_FILE, "utf8")));
  } catch (error) {
    setupFailed = true;
    context.metadata.setupError = safeError(error);
    console.error(safeError(error));
    for (const group of selected) for (const id of groups[group].ids) {
      if (!context.results.some((item) => item.id === id)) add(context, {
        id, name: group + " benchmark", component: group, scope: "setup failed", status: "failed", values: { error: safeError(error) }
      });
    }
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>((accept) => proxy!.close(() => accept())); }
    await Promise.allSettled(children.map(stop));
    for (const log of logs) log.end();
    if (needsDb) {
      try { await (await import("./database.bench")).cleanup(context); }
      catch (error) { context.metadata.cleanupError = safeError(error); setupFailed = true; }
      await context.prisma?.$disconnect();
    }
    const { getRedis } = await import("../../lib/redis");
    getRedis()?.disconnect();
    process.off("SIGINT", abort); process.off("SIGTERM", abort);
    const failed = setupFailed || aborted || context.results.some((metric) => metric.status !== "passed") || budgetChecks.some((check) => !check.passed);
    const path = saveReport(context, startedAt, new Date().toISOString(), budgetChecks);
    console.log("Report: " + path);
    console.log("Summary: " + resolve("artifacts/metrics/latest.md"));
    if (failed) { console.error("Some metrics failed or were unavailable. Logs: " + temporary); process.exitCode = 1; }
    else rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
