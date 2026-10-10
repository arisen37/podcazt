import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { selectiveRepeat } from "../../lib/selective-repeat";
import { RECORDING_PART_SIZE } from "../../lib/multipart";
import { add, integer, type Context } from "./common";

export async function hostedUploadMetrics(context: Context, session: string, register: (token: string) => Promise<unknown>) {
  const parts = integer("METRICS_UPLOAD_PARTS", 6, 3, 32);
  const payload = Buffer.alloc(RECORDING_PART_SIZE, 0x5a);
  const checksum = createHash("sha256").update(payload).digest("base64");
  const api = async (body: Record<string, unknown>) => {
    const response = await fetch(new URL("/api/record/s3", context.webUrl), {
      method: "POST", headers: { cookie: "podcazt_session=" + session, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
    });
    assert.equal(response.status, 200, "Upload API action " + body.action + " HTTP " + response.status);
    return await response.json();
  };
  const init = await api({ action: "init", roomId: context.fixture!.roomIds[0], recordingId: randomUUID(), byteSize: parts * payload.length });
  await register(init.token);
  assert.equal(init.partSize, payload.length); assert.equal(init.partCount, parts);
  // Wrong bytes with the correctly signed expected checksum must be rejected by S3.
  const corruptPart = await api({ action: "part", token: init.token, partNumber: 1, checksum: checksum });
  const corrupt = Buffer.from(payload); corrupt[0] ^= 1;
  const bad = await fetch(corruptPart.url, { method: "PUT", headers: { "x-amz-checksum-sha256": checksum }, body: corrupt, signal: AbortSignal.timeout(60_000) });
  const badBody = await bad.text();
  const corruptRejected = bad.status === 400 && badBody.includes("BadDigest");
  let attempts = 0;
  let injected = false;
  const start = performance.now();
  await selectiveRepeat(Array.from({ length: parts }, (_, i) => i + 1), async (partNumber) => {
    attempts++;
    const signed = await api({ action: "part", token: init.token, partNumber, checksum: checksum });
    const response = await fetch(signed.url, { method: "PUT", headers: { "x-amz-checksum-sha256": checksum }, body: payload, signal: AbortSignal.timeout(90_000) });
    await response.text();
    assert.equal(response.status, 200, "S3 upload failed");
    if (partNumber === 2 && !injected) { injected = true; throw new Error("Controlled lost application ACK after successful PUT"); }
  });
  const status = await api({ action: "status", token: init.token });
  assert.equal(status.parts.length, parts);
  for (let index = 0; index < parts; index++) {
    assert.equal(status.parts[index].partNumber, index + 1);
    assert.equal(status.parts[index].checksum, checksum);
    assert.equal(status.parts[index].size, payload.length);
  }
  const elapsedMs = performance.now() - start;
  const matches = status.parts.every((part: { checksum: string; size: number }) => part.checksum === checksum && part.size === payload.length);
  add(context, { id: "M10", name: "Selective-repeat S3 upload goodput and integrity", component: "Multipart S3 / SHA-256",
    scope: "client -> hosted authenticated upload API -> presigned regional S3 PUTs",
    status: matches && corruptRejected && attempts >= parts + 1 ? "passed" : "failed",
    values: { usefulPayloadMbitPerSecond: parts * payload.length * 8 / (elapsedMs / 1000) / 1e6,
      elapsedMs, parts, partBytes: payload.length, uniquePayloadBytes: parts * payload.length,
      sendAttempts: attempts, retryAttempts: attempts - parts, injectedRetries: 1,
      additionalRetries: attempts - parts - 1, windowLimit: 3,
      allPartChecksumsMatch: matches, completionTested: false, corruptedChunkRejected: corruptRejected, corruptResponseStatus: bad.status },
    notes: ["Fixed 0x5a bytes; one controlled lost application ACK for part 2 forces retransmission with real production backoff.",
      "Goodput includes presigning, retries, status validation; excludes initialization and corruption probe.",
      "Actual S3 checksum enforcement and listed per-part SHA-256 comparison. Multipart session is aborted during cleanup; completion/download are not exercised because the production IAM policy intentionally lacks DeleteObject."] });
}
