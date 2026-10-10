import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { createSessionToken, verifySessionToken } from "../../lib/auth";
import { assertRoomAccess } from "../../lib/rooms";
import { add, measure, percentage, requiredFixture, warmup, type Context } from "./common";
import { request } from "./http.bench";

export async function authMetrics(context: Context) {
  const { fixture } = requiredFixture(context);
  const valid = await createSessionToken(fixture.owner);
  const verify = async () => { assert.equal((await verifySessionToken(valid))?.id, fixture.owner.id); };
  await warmup(context.warmup, verify);
  const result = await measure(context.samples, verify);
  const { rawMs, ...values } = result;
  add(context, {
    id: "M03", name: "JWT session verification latency", component: "Stateless authentication",
    scope: "in-process real verifySessionToken, valid HS256 token",
    status: result.errors.length ? "failed" : "passed", values,
    samples: { verificationMs: rawMs },
    notes: ["Crypto and claim validation only; excludes HTTP, cookies, database work, and password hashing."]
  });
}
export async function securityMetrics(context: Context) {
  const { fixture } = requiredFixture(context);
  const encoder = new TextEncoder();
  const key = encoder.encode(process.env.SESSION_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const base = { typ: "session", sub: fixture.owner.id, email: fixture.owner.email,
    username: fixture.owner.username, name: fixture.owner.name,
    iss: "podcazt", aud: "podcazt-web", iat: now, exp: now + 300 };
  const sign = (changes: Record<string, unknown> = {}, signingKey = key, alg = "HS256") =>
    new SignJWT({ ...base, ...changes }).setProtectedHeader({ alg }).sign(signingKey);
  const valid = await createSessionToken(fixture.owner);
  const segments = valid.split(".");
  const altered = segments[0] + "." + Buffer.from(JSON.stringify({ ...base, email: "attacker@metrics.invalid" })).toString("base64url") + "." + segments[2];
  const negatives = [
    { name: "forged signature", token: await sign({}, randomBytes(32)) },
    { name: "modified payload", token: altered },
    { name: "expired beyond clock tolerance", token: await sign({ exp: now - 60 }) },
    { name: "wrong audience", token: await sign({ aud: "another-app" }) },
    { name: "wrong issuer", token: await sign({ iss: "another-issuer" }) },
    { name: "disallowed HS512 algorithm", token: await sign({}, key, "HS512") },
    { name: "wrong token type", token: await sign({ typ: "realtime" }) },
    { name: "invalid identity field", token: await sign({ email: null }) },
    { name: "not yet valid", token: await sign({ nbf: now + 60 }) },
    { name: "unsigned alg=none", token: Buffer.from('{"alg":"none"}').toString("base64url") + "." + Buffer.from(JSON.stringify(base)).toString("base64url") + "." },
    { name: "malformed JWT", token: "not.a.valid.jwt" }
  ];
  const checks: Array<{ name: string; expected: string; observed: string; passed: boolean }> = [];
  for (const item of negatives) {
    const rejected = await verifySessionToken(item.token) === null;
    checks.push({ name: item.name, expected: "rejected", observed: rejected ? "rejected" : "accepted", passed: rejected });
  }
  checks.push({ name: "valid token positive control", expected: "accepted", observed: "accepted",
    passed: (await verifySessionToken(valid))?.id === fixture.owner.id });
  const previous = process.env.SESSION_SECRET_PREVIOUS;
  try {
    process.env.SESSION_SECRET_PREVIOUS = randomBytes(32).toString("hex");
    const rotated = await sign({}, encoder.encode(process.env.SESSION_SECRET_PREVIOUS));
    const accepted = (await verifySessionToken(rotated))?.id === fixture.owner.id;
    checks.push({ name: "previous-key rotation positive control", expected: "accepted", observed: accepted ? "accepted" : "rejected", passed: accepted });
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET_PREVIOUS;
    else process.env.SESSION_SECRET_PREVIOUS = previous;
  }
  for (const path of ["/api/myVideos", "/api/incomingInvites", "/api/realtime-token", "/api/turn-credentials"]) {
    const response = await request(new URL(path, context.webUrl).href);
    checks.push({ name: "unauthenticated " + path, expected: "HTTP 401", observed: "HTTP " + response.status, passed: response.status === 401 });
  }
  const tamperedResponse = await request(new URL("/api/myVideos", context.webUrl).href, { headers: { cookie: "podcazt_session=" + altered } });
  checks.push({ name: "tampered cookie API access", expected: "HTTP 401", observed: "HTTP " + tamperedResponse.status, passed: tamperedResponse.status === 401 });
  const authorized = await request(new URL("/api/myVideos", context.webUrl).href, { headers: { cookie: "podcazt_session=" + valid } });
  checks.push({ name: "authenticated API positive control", expected: "HTTP 200", observed: "HTTP " + authorized.status, passed: authorized.status === 200 });
  const memberToken = await createSessionToken(fixture.member);
  const closeResponse = await request(new URL("/api/closeRoom", context.webUrl).href, {
    method: "POST", headers: { cookie: "podcazt_session=" + memberToken, "content-type": "application/json" },
    body: JSON.stringify({ roomId: fixture.roomIds[0] })
  });
  checks.push({ name: "member cannot close owner room", expected: "HTTP 403", observed: "HTTP " + closeResponse.status, passed: closeResponse.status === 403 });
  for (const [name, roomId, userId] of [
    ["outsider room access", fixture.roomIds[0], fixture.outsider.id],
    ["closed room owner access", fixture.closedRoomId, fixture.owner.id],
    ["nonexistent room access", fixture.missingRoomId, fixture.owner.id]
  ]) {
    let denied = false;
    try { await assertRoomAccess(roomId, userId); }
    catch (error) { denied = error instanceof Error && error.message.includes("access was denied"); }
    checks.push({ name, expected: "denied", observed: denied ? "denied" : "unexpected result", passed: denied });
  }
  const negativeChecks = checks.filter((check) => check.expected !== "accepted" && !check.name.includes("positive control"));
  add(context, {
    id: "M04", name: "Authentication and authorization case coverage", component: "JWT / API / room access control",
    scope: "enumerated fixture cases, real application helpers and HTTP routes",
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    values: { testedCases: checks.length, passedCases: checks.filter((check) => check.passed).length,
      negativeCases: negativeChecks.length, rejectedNegativeCases: negativeChecks.filter((check) => check.passed).length,
      negativeCaseRejectionPercent: percentage(negativeChecks.filter((check) => check.passed).length, negativeChecks.length), checks },
    notes: ["Coverage of this explicit test matrix only; not penetration-test coverage or a claim that all attacks are prevented. Positive controls detect a deny-everything implementation."]
  });
}
