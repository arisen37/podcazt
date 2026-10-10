import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { selectiveRepeat } from "../../lib/selective-repeat";
import { completePartSet, RECORDING_PART_SIZE } from "../../lib/multipart";
import { add, integer, percentage, type Context } from "./common";

export async function uploadMetrics(context: Context) {
  const partCount = integer("METRICS_UPLOAD_PARTS", 6, 3, 32);
  const delayMs = integer("METRICS_UPLOAD_DELAY_MS", 20, 0, 1000);
  const payload = Buffer.alloc(RECORDING_PART_SIZE, 0x5a);
  const checksum = createHash("sha256").update(payload).digest("base64");
  const attempts = new Map<number, number>();
  const accepted = new Map<number, Buffer>();
  const errors: string[] = [];
  let active = 0;
  let peakActive = 0;
  let requestBytes = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const index = Number(request.url?.slice(1));
      attempts.set(index, (attempts.get(index) ?? 0) + 1);
      active++; peakActive = Math.max(peakActive, active);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requestBytes += body.length;
      await setTimeout(delayMs);
      if (createHash("sha256").update(body).digest("base64") !== request.headers["x-checksum"]) {
        response.writeHead(409).end("checksum mismatch"); return;
      }
      // Deterministic lost-success/ACK scenario: part 2 is stored but first reply fails.
      accepted.set(index, body);
      if (index === 2 && attempts.get(index) === 1) { response.writeHead(503).end("injected response failure"); return; }
      response.writeHead(200).end("accepted");
    } catch { errors.push("fixture request failed"); response.destroy(); }
    finally { active--; }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let sends = 0;
  const before = performance.now();
  try {
    await selectiveRepeat(Array.from({ length: partCount }, (_, index) => index + 1), async (part) => {
      sends++;
      const response = await fetch("http://127.0.0.1:" + address.port + "/" + part, {
        method: "PUT", headers: { "x-checksum": checksum }, body: payload, signal: AbortSignal.timeout(10_000)
      });
      await response.text();
      if (!response.ok) throw new Error("Injected fixture HTTP " + response.status);
    });
    const elapsedMs = performance.now() - before;
    const byteSize = payload.length * partCount;
    const parts = Array.from({ length: partCount }, (_, index) => ({
      PartNumber: index + 1, ETag: "fixture-etag", ChecksumSHA256: checksum, Size: accepted.get(index + 1)?.length
    }));
    const sourceHash = createHash("sha256");
    const receivedHash = createHash("sha256");
    for (let index = 1; index <= partCount; index++) {
      sourceHash.update(payload); receivedHash.update(accepted.get(index)!);
    }
    const hashesMatch = sourceHash.digest("hex") === receivedHash.digest("hex");
    // Verify corrupt data is rejected by the transport fixture, outside goodput timing.
    const corruptResponse = await fetch("http://127.0.0.1:" + address.port + "/999", {
      method: "PUT", headers: { "x-checksum": checksum }, body: Buffer.from("corrupt"), signal: AbortSignal.timeout(10_000)
    });
    await corruptResponse.text();
    const passed = hashesMatch && completePartSet(parts, byteSize) && peakActive <= 3 && sends === partCount + 1
      && attempts.get(2) === 2 && corruptResponse.status === 409 && !errors.length;
    add(context, {
      id: "M10", name: "Selective-repeat upload goodput and integrity", component: "Multipart uploads / SHA-256",
      scope: "loopback HTTP fixture, deterministic first-response failure on part 2",
      status: passed ? "passed" : "failed",
      values: { partBytes: payload.length, parts: partCount, uniquePayloadBytes: byteSize,
        timedRequestBytes: requestBytes - Buffer.byteLength("corrupt"), elapsedMs,
        usefulPayloadMbitPerSecond: byteSize * 8 / (elapsedMs / 1000) / 1e6,
        sendAttempts: sends, retryAttempts: sends - partCount, retryOverheadPercent: percentage(sends - partCount, partCount),
        windowLimit: 3, peakInFlight: peakActive, finalSha256Matches: hashesMatch,
        corruptedChunkRejected: corruptResponse.status === 409, serverDelayMs: delayMs,
        retryBackoff: "production selectiveRepeat defaults (first retry waits 1000 ms)", errors },
      notes: ["Tests the real selectiveRepeat scheduler over HTTP with 8 MiB parts and production backoff.",
        "Fixture verifies checksum and final content; it is not a measured S3 throughput result or a test of AWS checksum enforcement."]
    });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
