import assert from "node:assert/strict";
import { test } from "node:test";
import { IceRecovery } from "../lib/ice-recovery";

function setup(offerer = true) {
  let now = 0;
  let canSignal = true;
  let failed = 0;
  let connecting = false;
  let offers = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timerId = 0;
  const sent: Array<{ type: string; payload?: RTCSessionDescriptionInit }> = [];
  const peer = {
    connectionState: "connected" as RTCPeerConnectionState,
    iceConnectionState: "connected" as RTCIceConnectionState,
    signalingState: "stable" as RTCSignalingState,
    remoteDescription: { type: "answer", sdp: "old" } as RTCSessionDescription,
    localDescription: null as RTCSessionDescription | null,
    async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
      assert.equal(options?.iceRestart, true);
      return { type: "offer", sdp: `fresh-credentials-${++offers}` };
    },
    async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
      peer.localDescription = description as RTCSessionDescription;
      peer.signalingState = "have-local-offer";
    }
  };
  const recovery = new IceRecovery(peer, {
    canSignal: () => canSignal,
    isOfferer: () => offerer,
    send: (message) => sent.push(message),
    onRecovering: () => { connecting = true; },
    onAttempt: () => {},
    onConnected: () => { connecting = false; },
    onFailed: () => { failed++; connecting = false; },
    now: () => now,
    schedule: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { at: now + delay, callback });
      return () => { timers.delete(id); };
    }
  });
  async function advance(milliseconds: number) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      // Let both SDP operations and the retry's finally block finish.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = target;
  }
  return {
    peer, recovery, sent, advance, timers,
    offline: () => { canSignal = false; },
    online: () => { canSignal = true; },
    get failed() { return failed; },
    get connecting() { return connecting; }
  };
}

test("network change sends fresh restart SDP before reporting an allocation failure", async () => {
  const call = setup();
  call.recovery.request();
  call.recovery.request();
  await call.advance(0);
  assert.equal(call.sent.length, 1);
  assert.equal(call.sent[0].type, "offer");
  assert.equal(call.sent[0].payload?.sdp, "fresh-credentials-1");
  assert.equal(call.connecting, true);
  assert.equal(call.failed, 0);
  call.peer.iceConnectionState = "checking";
  call.recovery.stateChanged();
  call.peer.signalingState = "stable";
  call.peer.iceConnectionState = "connected";
  call.recovery.stateChanged();
  await call.advance(60_000);
  assert.equal(call.sent.length, 1);
  assert.equal(call.connecting, false);
  assert.equal(call.failed, 0);
});

test("either participant can recover while only the elected peer sends SDP", async () => {
  const elected = setup();
  const other = setup(false);
  other.recovery.request();
  await other.advance(0);
  assert.deepEqual(other.sent, [{ type: "ice-restart" }]);
  elected.recovery.request();
  await elected.advance(0);
  assert.equal(elected.sent[0].type, "offer");
  elected.recovery.dispose();
  other.recovery.dispose();
});

test("ICE failure triggers recovery even before the aggregate state fails", async () => {
  const call = setup();
  call.peer.iceConnectionState = "failed";
  call.recovery.stateChanged();
  await call.advance(0);
  assert.equal(call.sent[0].type, "offer");
  call.recovery.dispose();
});

test("a successful restart may stay connected without another state event", async () => {
  const call = setup();
  call.recovery.request();
  await call.advance(0);
  call.peer.signalingState = "stable";
  await call.advance(60_000);
  assert.equal(call.sent.length, 1);
  assert.equal(call.failed, 0);
  assert.equal(call.connecting, false);
});

test("brief disconnections recover without sending unnecessary offers", async () => {
  const call = setup();
  call.peer.iceConnectionState = "disconnected";
  call.recovery.stateChanged();
  await call.advance(1_000);
  call.peer.iceConnectionState = "connected";
  call.recovery.stateChanged();
  await call.advance(2_000);
  assert.equal(call.sent.length, 0);
  assert.equal(call.connecting, false);
});

test("stalled ICE checking retries without requiring another failure event", async () => {
  const call = setup();
  call.recovery.request();
  await call.advance(0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    call.peer.signalingState = "stable";
    call.peer.connectionState = "connecting";
    call.peer.iceConnectionState = "checking";
    await call.advance(10_000);
    assert.equal(call.failed, attempt === 3 ? 1 : 0);
  }
  assert.equal(call.sent.length, 3);
  assert.equal(call.connecting, false);
});

test("recovery waits for signaling and an outstanding SDP exchange", async () => {
  const call = setup();
  call.offline();
  call.recovery.request();
  await call.advance(60_000);
  assert.equal(call.sent.length, 0);
  assert.equal(call.failed, 0);
  call.online();
  call.peer.signalingState = "have-remote-offer";
  await call.advance(1_000);
  assert.equal(call.sent.length, 0);
  call.peer.signalingState = "stable";
  call.recovery.signalingChanged();
  await call.advance(0);
  assert.equal(call.sent[0].type, "offer");
  call.recovery.dispose();
});

test("a missing answer has a bounded recovery timeout", async () => {
  const call = setup();
  call.recovery.request();
  await call.advance(45_000);
  assert.equal(call.sent.length, 1);
  assert.equal(call.failed, 1);
  assert.equal(call.timers.size, 0);
});

test("closing a call cancels pending and in-flight recovery", async () => {
  const call = setup();
  let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
  call.peer.createOffer = () => new Promise((resolve) => { resolveOffer = resolve; });
  call.recovery.request();
  await call.advance(0);
  call.recovery.dispose();
  resolveOffer({ type: "offer", sdp: "late" });
  await call.advance(60_000);
  assert.equal(call.sent.length, 0);
  assert.equal(call.peer.localDescription, null);
  assert.equal(call.failed, 0);
  assert.equal(call.timers.size, 0);
});
