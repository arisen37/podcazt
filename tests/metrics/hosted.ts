import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { add, integer, type Context, type Fixture, type Metric } from "./common";
import { httpMetrics, tlsMetrics, request } from "./http.bench";
import { signalingMetrics } from "./signaling.bench";
import { webrtcMetrics } from "./webrtc.bench";
import { hostedUploadMetrics } from "./hosted-upload.bench";
import { saveReport, evaluateBudgets } from "./report";

const host = process.env.METRICS_SSH_HOST ?? "13.51.197.83";
const user = process.env.METRICS_SSH_USER ?? "ubuntu";
const key = process.env.METRICS_SSH_KEY ?? "enryu.pem";
assert.match(host, /^[a-zA-Z0-9.-]+$/); assert.match(user, /^[a-zA-Z0-9_-]+$/);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sshArgs = ["-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", user + "@" + host];
function command(program: string, args: string[], input?: string) {
  return new Promise<string>((accept, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let stderr = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept(output) : reject(new Error(program + " exited " + code + ": " + stderr.slice(-2500))));
    child.stdin.end(input);
  });
}
async function main() {
  const groups: Record<string, string[]> = { http: ["M01"], tls: ["M02"], backend: ["M03", "M04", "M05", "M06", "M07"],
    signaling: ["M08", "M09"], upload: ["M10"], webrtc: ["M11", "M12", "M13", "M14", "M15"] };
  const cleanupArg = process.argv.slice(2).find((arg) => arg.startsWith("--cleanup="));
  const onlyArg = process.argv.slice(2).find((arg) => arg.startsWith("--only="));
  assert.ok(!(cleanupArg && onlyArg), "Choose cleanup or a metric subset");
  assert.ok(process.argv.slice(2).every((arg) => arg === cleanupArg || arg === onlyArg), "Usage: npm run metrics:hosted [-- --only=http,tls,backend,signaling,upload,webrtc | --cleanup=metrics-RUN-ID]");
  const selected = onlyArg ? onlyArg.slice(7).split(",") : Object.keys(groups);
  assert.ok(selected.length && selected.every((group) => groups[group]), "Unknown hosted metric group");
  assert.equal(new Set(selected).size, selected.length, "Repeated hosted metric group");
  const runId = cleanupArg?.slice(10) ?? "metrics-" + Date.now().toString(36) + "-" + randomBytes(4).toString("hex");
  assert.match(runId, /^metrics-[a-z0-9-]+$/);
  const remote = "/home/" + user + "/podcazt-metrics/" + runId;
  const deployment = process.env.METRICS_DEPLOY_DIR ?? "/opt/podcazt/deploy/aws";
  const ssh = (script: string, input?: string) => command("ssh", [...sshArgs, script], input);
  const context: Context = {
    runId, samples: integer("METRICS_SAMPLES", 100, 10, 1000), warmup: integer("METRICS_WARMUP", 10, 0, 100), concurrency: 4,
    fixtureRows: 1, mediaRuns: integer("METRICS_MEDIA_RUNS", 3, 1, 20), mediaSeconds: integer("METRICS_MEDIA_SECONDS", 10, 3, 120),
    httpUrl: process.env.METRICS_HOSTED_URL ?? "https://podcazt.arisen37.xyz",
    webUrl: process.env.METRICS_HOSTED_URL ?? "https://podcazt.arisen37.xyz", signalingUrl: "", results: [], metadata: { hosted: true,
      clientNode: process.version, clientOS: os.platform() + " " + os.release(), clientArch: os.arch(), clientCpu: os.cpus()[0]?.model,
      clientMemoryBytes: os.totalmem(), percentileMethod: "nearest rank; successful samples only; errors separately reported" }
  };
  const origin = new URL(context.webUrl);
  assert.equal(origin.protocol, "https:"); assert.ok(!origin.username && !origin.password && !origin.search);
  context.signalingUrl = "wss://" + origin.host + "/ws";
  const agent = async (action: string, input?: string) => JSON.parse(await ssh(
    "sudo docker compose --project-directory " + quote(deployment) + " run --rm --no-deps -T -v " + quote(remote + ":/app/tests/metrics") +
    " --entrypoint node web --import tsx tests/metrics/hosted-agent.ts " + action + " " + runId + " " + context.samples + " " + context.warmup, input));
  const clean = async () => {
    const result = await agent("cleanup");
    assert.equal(result.cleaned, true);
    // Remove only this strictly validated run directory, after verified fixture cleanup.
    await ssh("rm -rf -- " + quote(remote));
    return result;
  };
  if (cleanupArg) { console.log(await clean()); return; }
  const startedAt = new Date().toISOString();
  let prepared = false;
  let setupAttempted = false;
  try {
    console.log("Hosted run ID: " + runId);
    await ssh("mkdir -p " + quote(remote) + " && chmod 700 " + quote(remote)); prepared = true;
    const files = readdirSync("tests/metrics").filter((file) => file.endsWith(".ts"));
    const hash = createHash("sha256"); for (const file of files.sort()) hash.update(file).update(readFileSync("tests/metrics/" + file));
    context.metadata.harnessSha256 = hash.digest("hex");
    context.metadata.selectedGroups = selected;
    context.metadata.lockfileSha256 = createHash("sha256").update(readFileSync("package-lock.json")).digest("hex");
    context.metadata.clientCommit = (await command("git", ["rev-parse", "HEAD"])).trim();
    context.metadata.clientWorkingTreeDirty = Boolean((await command("git", ["status", "--porcelain"])).trim());
    context.metadata.clientLoadAtStart = os.loadavg();
    await command("scp", ["-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", ...files.map((file) => "tests/metrics/" + file), user + "@" + host + ":" + remote + "/"]);
    context.metadata.deployedCommit = (await ssh("git -C /home/" + user + "/podcazt rev-parse HEAD")).trim();
    context.metadata.serverImageId = (await ssh("sudo docker inspect podcazt-web-1 --format '{{.Image}}'")).trim();
    setupAttempted = true;
    const setup = await agent("setup") as { fixture: Fixture; realtimeTokens: Record<string, string>; session: string; sessionTokens: Record<string, string>; environment: Record<string, unknown> };
    context.fixture = setup.fixture; context.realtimeTokens = setup.realtimeTokens;
    Object.assign(context.metadata, setup.environment, { httpTarget: origin.origin, topology: "client HTTPS/WSS -> EC2 Nginx; backend helpers in one-off production image; two client browsers forced through hosted TURN" });
    if (selected.includes("backend")) {
      const backend = await agent("backend") as { metrics: Metric[] };
      for (const metric of backend.metrics) add(context, metric);
    }
    for (const [name, ids, fn] of [
      ["http", ["M01"], () => httpMetrics(context)],
      ["tls", ["M02"], () => tlsMetrics(context)],
      ["signaling", ["M08", "M09"], () => signalingMetrics(context)],
      ["upload", ["M10"], () => hostedUploadMetrics(context, setup.session, (token: string) => agent("register-upload", token))],
      ["webrtc", ["M11", "M12", "M13", "M14", "M15"], async () => {
        context.peerIceServers = [];
        for (const user of [setup.fixture.owner, setup.fixture.member]) {
          const response = await request(new URL("/api/turn-credentials", context.webUrl).href, { headers: { cookie: "podcazt_session=" + setup.sessionTokens[user.id] } });
          assert.equal(response.status, 200);
          context.peerIceServers.push(JSON.parse(response.body).iceServers);
        }
        context.iceServers = context.peerIceServers[0]; context.forceRelay = true;
        await webrtcMetrics(context);
      }]
    ] as Array<[string, string[], () => Promise<void>]>) {
      if (!selected.includes(name)) continue;
      try { await fn(); } catch (error) {
        for (const id of ids.filter((id) => !context.results.some((metric) => metric.id === id))) add(context, {
          id, name, component: name, scope: "hosted benchmark", status: "failed", values: { error: safeError(error) }
        });
      }
    }
  } catch (error) {
    context.metadata.setupError = safeError(error); process.exitCode = 1;
  } finally {
    if (prepared && setupAttempted) {
      try { context.metadata.cleanup = await clean(); }
      catch (error) { context.metadata.cleanupError = safeError(error); process.exitCode = 1;
        console.error("Retry cleanup: npm run metrics:hosted -- --cleanup=" + runId); }
    } else if (prepared) await ssh("rm -rf -- " + quote(remote));
    for (const id of selected.flatMap((group) => groups[group])) {
      if (!context.results.some((metric) => metric.id === id)) add(context, { id, name: "setup failed", component: "hosted", scope: "hosted setup", status: "failed", values: {} });
    }
    const budgets = process.env.METRICS_BUDGET_FILE ? evaluateBudgets(context.results, JSON.parse(readFileSync(process.env.METRICS_BUDGET_FILE, "utf8"))) : [];
    console.log("Report: " + saveReport(context, startedAt, new Date().toISOString(), budgets));
    if (context.results.some((metric) => metric.status !== "passed") || budgets.some((budget) => !budget.passed)) process.exitCode = 1;
  }
}
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/([?&](?:token|X-Amz-[^=\s]+)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]");
}
main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
