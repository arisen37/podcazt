import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { selectiveRepeat } from "../lib/selective-repeat";
import { ReliableSignaling, type ReliableMessage } from "../lib/reliable-signaling";
import { createTurnCredentials } from "../lib/turn";
import { completePartSet, RECORDING_PART_SIZE } from "../lib/multipart";

test("multipart completion rejects missing, duplicate, truncated, and unverified parts", () => {
  const parts = [
    { PartNumber: 1, ETag: "one", ChecksumSHA256: "verified", Size: RECORDING_PART_SIZE },
    { PartNumber: 2, ETag: "two", ChecksumSHA256: "verified", Size: 123 }
  ];
  const size = RECORDING_PART_SIZE + 123;
  assert.equal(completePartSet(parts, size), true);
  assert.equal(completePartSet(parts.slice(0, 1), size), false);
  assert.equal(completePartSet([parts[0], { ...parts[1], PartNumber: 1 }], size), false);
  assert.equal(completePartSet([parts[0], { ...parts[1], Size: 122 }], size), false);
  assert.equal(completePartSet([parts[0], { ...parts[1], ChecksumSHA256: undefined }], size), false);
});

test("uploads keep a bounded window and selectively retry failed parts", async () => {
  const calls = new Map<number, number>();
  let active = 0;
  let peak = 0;
  await selectiveRepeat([1, 2, 3, 4, 5, 6], async (part) => {
    active++;
    peak = Math.max(peak, active);
    calls.set(part, (calls.get(part) ?? 0) + 1);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (part === 2 && calls.get(part) === 1) throw new Error("lost acknowledgement");
  }, { wait: async () => {} });
  assert.equal(peak, 3);
  assert.equal(calls.get(2), 2);
  for (const part of [1, 3, 4, 5, 6]) assert.equal(calls.get(part), 1);
});

test("permanent upload failure waits for in-flight work before exposing Retry", async () => {
  let active = 0;
  await assert.rejects(selectiveRepeat([1, 2, 3, 4], async (part) => {
    active++;
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (part === 1) throw new Error("offline");
  }, { attempts: 1 }), /offline/);
  assert.equal(active, 0);
});

test("signaling retries a dropped ACK without applying an offer twice", () => {
  let now = 0;
  const sent: ReliableMessage[] = [];
  const replies: ReliableMessage[] = [];
  const sender = new ReliableSignaling((m) => sent.push(m), assert.fail, () => now, () => "offer-1");
  const receiver = new ReliableSignaling((m) => replies.push(m), assert.fail);
  sender.send({ type: "offer", payload: { sdp: "example" } });
  assert.equal(receiver.receive(sent[0]), false);
  receiver.processed(sent[0]);
  // Lose the initial acknowledgement, then recover the duplicate's ACK.
  now = 1000;
  sender.tick();
  assert.equal(receiver.receive(sent[1]), true);
  sender.receive(replies[1]);
  now = 20000;
  sender.tick();
  assert.equal(sent.length, 2);
});

test("signaling window advances when one message is acknowledged", () => {
  const sent: ReliableMessage[] = [];
  let id = 0;
  const sender = new ReliableSignaling((m) => sent.push(m), assert.fail, () => 0, () => String(++id));
  for (let i = 0; i < 12; i++) sender.send({ type: "ice-candidate" });
  assert.equal(sent.length, 8);
  sender.receive({ type: "signal-ack", ackId: "3" });
  assert.equal(sent.length, 9);
  assert.equal(sent[8].messageId, "9");
});

test("signaling reports exhausted retries rather than claiming delivery", () => {
  let now = 0;
  let failures = 0;
  let sends = 0;
  const sender = new ReliableSignaling(() => sends++, () => failures++, () => now);
  sender.send({ type: "answer" });
  for (let i = 0; i < 8; i++) { now += 10000; sender.tick(); }
  assert.equal(sends, 6);
  assert.equal(failures, 1);
});

test("network recovery requests are retried and acknowledged", () => {
  let now = 0;
  const sent: ReliableMessage[] = [];
  const sender = new ReliableSignaling((message) => sent.push(message), assert.fail, () => now, () => "restart-1");
  sender.send({ type: "ice-restart", targetPeerId: "elected-peer" });
  now = 1_000;
  sender.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].messageId, "restart-1");
  sender.receive({ type: "signal-ack", ackId: "restart-1" });
  now = 20_000;
  sender.tick();
  assert.equal(sent.length, 2);
});

test("Coturn credentials have an expiry and the expected HMAC", () => {
  const previousHost = process.env.TURN_HOST;
  const previousSecret = process.env.TURN_SHARED_SECRET;
  try {
    process.env.TURN_HOST = "turn.test.example";
    process.env.TURN_SHARED_SECRET = "a".repeat(64);
    const result = createTurnCredentials("user-id", 1000000)!;
    assert.equal(result.expiresAt, 44200);
    const server = result.iceServers[1];
    assert.equal(server.username, "44200:user-id");
    assert.equal(server.credential, createHmac("sha1", "a".repeat(64)).update("44200:user-id").digest("base64"));
    assert.ok(server.urls.includes("turns:turn.test.example:5349?transport=tcp"));
  } finally {
    if (previousHost === undefined) delete process.env.TURN_HOST; else process.env.TURN_HOST = previousHost;
    if (previousSecret === undefined) delete process.env.TURN_SHARED_SECRET; else process.env.TURN_SHARED_SECRET = previousSecret;
  }
});
