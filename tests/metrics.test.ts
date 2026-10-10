import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize, percentage, type Metric } from "./metrics/common";
import { counterDelta, mediaIntervals, selectedPath, type StatsRow } from "./metrics/webrtc-stats";
import { evaluateBudgets } from "./metrics/report";

test("metric percentiles use nearest rank and preserve the input samples", () => {
  const values = [5, 1, 4, 2, 3];
  assert.deepEqual(summarize(values), { count: 5, min: 1, mean: 3, p50: 3, p95: 5, p99: 5, max: 5 });
  assert.deepEqual(values, [5, 1, 4, 2, 3]);
  assert.equal(summarize(Array.from({ length: 100 }, (_, index) => index + 1)).p95, 95);
});
test("missing or invalid metrics are never converted into reassuring zeroes", () => {
  assert.equal(summarize([]).p95, null);
  assert.equal(percentage(0, 0), null);
  assert.throws(() => summarize([NaN]));
  assert.throws(() => summarize([-1]));
  assert.equal(counterDelta(undefined, 10), null);
  assert.equal(counterDelta(100, 5), null);
});
const before: StatsRow = {
  id: "video", type: "inbound-rtp", kind: "video", timestamp: 1000,
  packetsReceived: 100, packetsLost: 1, framesDecoded: 10, framesDropped: 0
};
test("media rates use counter deltas, stats timestamps, and seconds-to-ms jitter conversion", () => {
  const [result] = mediaIntervals([before], [{ ...before, timestamp: 3000, packetsReceived: 198, packetsLost: 3,
    framesDecoded: 100, framesDropped: 10, jitter: 0.004 }]);
  assert.equal(result.packetLossPercent, 2);
  assert.equal(result.decodeDropPercent, 10);
  assert.equal(result.decodedFps, 45);
  assert.equal(result.jitterMs, 4);
});
test("late packet corrections remain visible and counter resets are excluded", () => {
  const [late] = mediaIntervals([{ ...before, packetsLost: 3 }], [{ ...before, timestamp: 2000, packetsReceived: 200, packetsLost: 1 }]);
  assert.equal(late.rawLostDelta, -2);
  assert.equal(late.lateLossCorrection, 2);
  assert.equal(late.lost, 0);
  const [reset] = mediaIntervals([before], [{ ...before, timestamp: 2000, packetsReceived: 1, framesDecoded: 1 }]);
  assert.equal(reset.packetLossPercent, null);
  assert.equal(reset.decodedFps, null);
});
test("selected ICE path comes from the transport reference, not an arbitrary succeeded pair", () => {
  const rows: StatsRow[] = [
    { id: "transport", type: "transport", timestamp: 1, selectedCandidatePairId: "chosen" },
    { id: "other", type: "candidate-pair", timestamp: 1, nominated: true, state: "succeeded", currentRoundTripTime: 1 },
    { id: "chosen", type: "candidate-pair", timestamp: 1, localCandidateId: "local", currentRoundTripTime: 0.003 },
    { id: "local", type: "local-candidate", timestamp: 1, candidateType: "relay", protocol: "udp" }
  ];
  assert.equal(selectedPath(rows)?.rttMs, 3);
  assert.equal(selectedPath(rows)?.localType, "relay");
  assert.equal(selectedPath([]), null);
});
test("optional budgets fail unavailable values and unknown rules", () => {
  const metric: Metric = { id: "M01", name: "http", component: "http", scope: "test", status: "passed", values: { latencyMs: { p95: 10 } } };
  assert.equal(evaluateBudgets([metric], { M01: { "latencyMs.p95": { max: 20 } } })[0].passed, true);
  assert.equal(evaluateBudgets([metric], { M01: { "missing.p95": { max: 20 } } })[0].passed, false);
  assert.equal(evaluateBudgets([{ ...metric, status: "unavailable" }], { M01: { "latencyMs.p95": { max: 20 } } })[0].passed, false);
  assert.throws(() => evaluateBudgets([metric], { M99: { value: { max: 20 } } }));
  assert.throws(() => evaluateBudgets([metric], { M01: { value: { mx: 20 } } }));
});
