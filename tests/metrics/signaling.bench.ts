import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { add, measure, percentage, requiredFixture, type Context } from "./common";
import { connect, MetricsSocket, socketUrl } from "./socket";

export async function signalingMetrics(context: Context) {
  const { fixture } = requiredFixture(context);
  const roomId = fixture.roomIds[0];
  const joinMs: number[] = [];
  const joinErrors: string[] = [];
  for (let index = 0; index < context.warmup + context.samples; index++) {
    const url = await socketUrl(context, fixture.owner);
    const start = performance.now();
    const client = new MetricsSocket(url);
    try {
      await client.wait((message) => message.type === "ready");
      client.send({ type: "join", roomId });
      await client.wait((message) => message.type === "peers");
      if (index >= context.warmup) joinMs.push(performance.now() - start);
    } catch (error) {
      if (index >= context.warmup) joinErrors.push(error instanceof Error ? error.message : String(error));
    } finally { await client.close(); }
  }
  const { summarize } = await import("./common");
  add(context, {
    id: "M08", name: "Authenticated WebSocket room join", component: "WebSocket / JWT / DB authorization",
    scope: new URL(context.signalingUrl).origin, status: joinErrors.length ? "failed" : "passed",
    values: { joinMs: summarize(joinMs), attempted: context.samples, successful: joinMs.length, errors: joinErrors },
    samples: { joinMs },
    notes: ["TCP/WebSocket upgrade, server JWT verification, and authorized peers response; client token creation and close teardown excluded."]
  });
  const a = await connect(context, fixture.owner, roomId);
  const b = await connect(context, fixture.member, roomId);
  let outsider: MetricsSocket | undefined;
  try {
    const roundtrip = await measure(context.samples, async () => {
      const nonce = randomUUID();
      const payload = { nonce, padding: "x".repeat(1024) };
      const received = b.client.wait((message) => message.type === "offer" && message.payload?.nonce === nonce);
      a.client.send({ type: "offer", roomId, targetPeerId: b.peerId, messageId: randomUUID(), payload });
      const offer = await received;
      assert.equal(offer.peerId, a.peerId);
      const echoed = a.client.wait((message) => message.type === "answer" && message.payload?.nonce === nonce);
      b.client.send({ type: "answer", roomId, targetPeerId: a.peerId, messageId: randomUUID(), payload: offer.payload });
      const answer = await echoed;
      assert.equal(answer.peerId, b.peerId);
    });
    const badUrl = new URL(context.signalingUrl);
    badUrl.searchParams.set("token", "invalid.jwt.signature");
    const invalidStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(badUrl, { handshakeTimeout: 5000 });
      socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); socket.terminate(); });
      socket.once("open", () => { resolve(101); socket.close(); });
      socket.once("error", () => reject(new Error("Invalid-token probe failed without an HTTP rejection response")));
    });
    outsider = new MetricsSocket(await socketUrl(context, fixture.outsider));
    await outsider.wait((message) => message.type === "ready");
    outsider.send({ type: "join", roomId });
    const denied = await outsider.wait((message) => message.type === "error");
    const { rawMs, ...timing } = roundtrip;
    const securityPassed = invalidStatus === 401 && typeof denied.message === "string" && denied.message.includes("access was denied");
    add(context, {
      id: "M09", name: "SDP/ICE routing round-trip and delivery", component: "Reliable signaling",
      scope: "two authorized fixture peers, real signaling server",
      status: !roundtrip.errors.length && securityPassed ? "passed" : "failed",
      values: { ...timing, payloadPaddingBytes: 1024, deliveryPercent: percentage(roundtrip.successful, roundtrip.attempted),
        routing: context.metadata.signalingRouting ?? "Redis pub/sub (SINGLE_INSTANCE_SIGNALING=false)",
        invalidJwtUpgradeStatus: invalidStatus, outsiderRoomDenied: securityPassed },
      samples: { signalingRoundtripMs: rawMs },
      notes: ["Application message echo through both peer routes with automatic ACKs; payloads are synthetic negotiation messages, not an SDP parsing test. No WAN packet loss is injected."]
    });
  } finally { await Promise.allSettled([a.client.close(), b.client.close(), outsider?.close()]); }
}
