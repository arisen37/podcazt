// Runs inside the existing production image; production secrets never leave it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import { SignJWT, jwtVerify } from "jose";
import { AbortMultipartUploadCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getS3, getS3Bucket } from "../../lib/s3";
import { prisma } from "../../lib/prisma";
import { getRedis } from "../../lib/redis";
import { createRealtimeToken } from "../../lib/realtime-token";
import { seed, cleanup, databaseMetrics } from "./database.bench";
import { authMetrics, securityMetrics } from "./security.bench";
import { redisMetrics, rateLimitMetrics } from "./redis.bench";
import type { Context, Fixture } from "./common";

const [action, runId, samplesText = "100", warmupText = "10"] = process.argv.slice(2);
assert.match(runId, /^metrics-[a-z0-9-]+$/);
const path = "/app/tests/metrics/state-" + runId + ".json";
type State = { fixture: Fixture; upload?: { key: string; uploadId: string } };
let state: State | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
const persist = () => writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
const context: Context = {
  runId, samples: Number(samplesText), warmup: Number(warmupText), concurrency: 4,
  fixtureRows: 1, mediaRuns: 3, mediaSeconds: 10,
  httpUrl: "http://web:3000", webUrl: "http://web:3000", signalingUrl: "ws://signaling:4000/ws",
  prisma, fixture: state?.fixture, results: [], metadata: { hosted: true },
  registerFixture: (fixture) => { state = { fixture }; persist(); }
};
console.log = (...args: unknown[]) => console.error(...args);
async function main() {
  if (action === "setup") {
    assert.ok(!state, "Run already exists; clean it first");
    await seed(context);
    const tokens: Record<string, string> = {};
    for (const user of [context.fixture!.owner, context.fixture!.member, context.fixture!.outsider]) tokens[user.id] = await createRealtimeToken(user);
    const sessionTokens: Record<string, string> = {};
    for (const user of [context.fixture!.owner, context.fixture!.member]) {
    sessionTokens[user.id] = await new SignJWT({ typ: "session", email: user.email, username: user.username, name: user.name })
      .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuer("podcazt").setAudience("podcazt-web")
      .setIssuedAt().setExpirationTime("10m").sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    }
    return { fixture: context.fixture, realtimeTokens: tokens, session: sessionTokens[context.fixture!.owner.id], sessionTokens,
      environment: { serverNode: process.version, serverPlatform: os.platform(), serverArch: os.arch(),
        serverMemoryBytes: os.totalmem(), database: context.metadata.database,
        signalingRouting: process.env.SINGLE_INSTANCE_SIGNALING === "true" ? "in-process (SINGLE_INSTANCE_SIGNALING=true)" : "Redis pub/sub" } };
  }
  if (action === "backend") {
    assert.ok(state);
    for (const fn of [authMetrics, securityMetrics, redisMetrics, rateLimitMetrics, databaseMetrics]) await fn(context);
    return { metrics: context.results };
  }
  if (action === "register-upload") {
    assert.ok(state);
    let token = "";
    for await (const chunk of process.stdin) token += chunk;
    const { payload } = await jwtVerify(token.trim(), new TextEncoder().encode(process.env.SESSION_SECRET), {
      issuer: "podcazt", audience: "s3-upload", algorithms: ["HS256"]
    });
    assert.equal(payload.userId, state.fixture.owner.id);
    assert.equal(payload.roomId, state.fixture.roomIds[0]);
    assert.ok(typeof payload.key === "string" && typeof payload.uploadId === "string");
    state.upload = { key: payload.key, uploadId: payload.uploadId }; persist();
    return { registered: true };
  }
  if (action === "cleanup") {
    if (!state) return { cleaned: true, alreadyClean: true };
    let storageError: unknown;
    try { if (state.upload) {
      try { await getS3().send(new AbortMultipartUploadCommand({ Bucket: getS3Bucket(), Key: state.upload.key, UploadId: state.upload.uploadId })); }
      catch (error) { if ((error as { name?: string }).name !== "NoSuchUpload") throw error; }
      let exists = false;
      try { await getS3().send(new HeadObjectCommand({ Bucket: getS3Bucket(), Key: state.upload.key })); exists = true; }
      catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error; }
      if (exists) await getS3().send(new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: state.upload.key }));
    } } catch (error) { storageError = error; }
    await cleanup(context);
    assert.equal(await prisma.user.count({ where: { id: { in: [state.fixture.owner.id, state.fixture.member.id, state.fixture.outsider.id] } } }), 0);
    if (storageError) throw storageError; // Retain S3 state for a cleanup retry; DB rows are already gone.
    unlinkSync(path);
    return { cleaned: true, remainingFixtureUsers: 0 };
  }
  throw new Error("Unknown agent action");
}
main().then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); getRedis()?.disconnect(); });
