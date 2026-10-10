import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "node:path";
import { add, percentage, requiredFixture, summarize, until, type Context } from "./common";
import { socketUrl } from "./socket";
import { mediaIntervals, selectedPath, type StatsRow } from "./webrtc-stats";

export async function webrtcMetrics(context: Context) {
  const { fixture } = requiredFixture(context);
  const relay = context.forceRelay ?? process.env.METRICS_FORCE_RELAY === "true";
  const iceServers: RTCIceServer[] = context.iceServers ?? JSON.parse(process.env.METRICS_ICE_SERVERS_JSON ?? "[]");
  assert.ok(Array.isArray(iceServers), "METRICS_ICE_SERVERS_JSON must be an array");
  if (relay) assert.ok(iceServers.some((server) => JSON.stringify(server.urls).includes("turn")), "Forced relay requires TURN credentials");
  const bundle = await build({
    entryPoints: [resolve("tests/metrics/browser.ts")], bundle: true, write: false, platform: "browser", format: "iife"
  });
  const browserScript = bundle.outputFiles[0].text;
  const server = http.createServer((request, response) => {
    if (request.url === "/browser.js") response.writeHead(200, { "content-type": "text/javascript" }).end(browserScript);
    else response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><title>Podcazt metrics fixture</title><script src="/browser.js"></script>');
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const setupMs: number[] = [];
  const recoveryMs: number[] = [];
  const snapshots: Array<{ run: number; peer: number; tick: number; stats: StatsRow[] }> = [];
  const intervals: ReturnType<typeof mediaIntervals> = [];
  const rttMs: number[] = [];
  const paths: NonNullable<ReturnType<typeof selectedPath>>[] = [];
  const errors: string[] = [];
  const browsers: Browser[] = [];
  let version = "";
  try {
    for (let run = 0; run < context.mediaRuns; run++) {
      const peers: Page[] = [];
      try {
        for (let peer = 0; peer < 2; peer++) {
          const browser = await chromium.launch({
            headless: true,
            ...(process.env.METRICS_BROWSER_CHANNEL ? { channel: process.env.METRICS_BROWSER_CHANNEL } : {}),
            // Same-host synthetic peers have no getUserMedia permission grant;
            // expose host candidates in this private harness so mDNS does not prevent local routing.
            args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
              ...(relay ? [] : ["--disable-features=WebRtcHideLocalIpsWithMdns"])]
          });
          browsers.push(browser); version = browser.version();
          const page = await browser.newPage();
          peers.push(page);
          await page.goto(url);
          await page.evaluate((settings) => window.metricPeer.start(settings), {
            socketUrl: await socketUrl(context, peer === 0 ? fixture.owner : fixture.member),
            roomId: fixture.roomIds[0], remoteUserId: peer === 0 ? fixture.member.id : fixture.owner.id,
            offerer: peer === 0, iceServers: context.peerIceServers?.[peer] ?? iceServers, relay
          });
        }
        await until(async () => (await Promise.all(peers.map((page) => page.evaluate(() => {
          if (window.metricPeer.error) throw new Error(window.metricPeer.error);
          return window.metricPeer.ready && Boolean(window.metricPeer.target);
        })))).every(Boolean), "both browser room joins");
        const start = performance.now();
        await peers[0].evaluate(() => window.metricPeer.offer());
        await until(async () => (await Promise.all(peers.map((page) => page.evaluate(() => {
          if (window.metricPeer.error) throw new Error(window.metricPeer.error);
          return window.metricPeer.connected();
        })))).every(Boolean), "WebRTC media and data connections");
        await until(async () => (await Promise.all(peers.map(async (page) =>
          (await page.evaluate(() => window.metricPeer.stats())).some((row) => row.type === "inbound-rtp" && (row.framesDecoded ?? 0) > 0)
        ))).every(Boolean), "first decoded video frames");
        await peers[0].evaluate(() => window.metricPeer.ping());
        setupMs.push(performance.now() - start);
        const previous: StatsRow[][] = [[], []];
        for (let tick = 0; tick <= context.mediaSeconds; tick++) {
          if (tick > 0) await setTimeout(1000);
          for (let peer = 0; peer < peers.length; peer++) {
            const stats = await peers[peer].evaluate(() => window.metricPeer.stats());
            snapshots.push({ run, peer, tick, stats });
            const path = selectedPath(stats);
            if (path) {
              paths.push(path);
              if (path.rttMs !== null && path.rttMs >= 0) rttMs.push(path.rttMs);
              if (relay) {
                assert.equal(path.localType, "relay", "relay mode must actually select a local relay candidate");
                assert.equal(path.remoteType, "relay", "both peers must actually select relay candidates");
              }
            }
            if (tick > 0) intervals.push(...mediaIntervals(previous[peer], stats).filter((interval) => interval.validTime));
            previous[peer] = stats;
          }
        }
        await peers[0].evaluate(() => window.metricPeer.restart());
        let recovered: number | null = null;
        await until(async () => {
          recovered = await peers[0].evaluate(() => {
            if (window.metricPeer.error) throw new Error(window.metricPeer.error);
            return window.metricPeer.recoveryResult();
          });
          return recovered !== null;
        }, "controlled ICE restart", 45_000);
        assert.ok(recovered !== null);
        recoveryMs.push(recovered);
      } catch (error) {
        const diagnostics = await Promise.all(peers.map((page) => page.evaluate(async () => ({
          connection: window.metricPeer.pc.connectionState,
          ice: window.metricPeer.pc.iceConnectionState,
          signaling: window.metricPeer.pc.signalingState,
          data: window.metricPeer.channel?.readyState,
          descriptions: [window.metricPeer.pc.localDescription?.type, window.metricPeer.pc.remoteDescription?.type],
          messages: window.metricPeer.receivedTypes,
          iceErrors: window.metricPeer.iceErrors,
          candidateTypes: (await window.metricPeer.stats()).filter((row) => row.type.includes("candidate")).map((row) => ({ type: row.type, state: row.state, candidateType: row.candidateType }))
        })).catch(() => null)));
        errors.push("run " + run + ": " + (error instanceof Error ? error.message : String(error)) + " " + JSON.stringify(diagnostics));
      } finally {
        await Promise.allSettled(peers.map((page) => page.evaluate(() => window.metricPeer.close())));
        // Give Chromium's network process time to send TURN Refresh(lifetime=0)
        // before browser.close kills it. This is outside all timed measurements.
        if (relay && peers.length) await setTimeout(2000);
        await Promise.allSettled(browsers.splice(0).map((browser) => browser.close()));
      }
    }
  } finally {
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
  const scope = relay ? "two same-host Chromium processes, forced TURN relay" : "two same-host Chromium processes, eligible ICE paths";
  const packetIntervals = intervals.filter((item) => item.received !== null && item.lost !== null);
  const frameIntervals = intervals.filter((item) => item.decoded !== null && item.dropped !== null);
  const received = packetIntervals.reduce((sum, item) => sum + item.received!, 0);
  const lost = packetIntervals.reduce((sum, item) => sum + item.lost!, 0);
  const decoded = frameIntervals.reduce((sum, item) => sum + item.decoded!, 0);
  const dropped = frameIntervals.reduce((sum, item) => sum + item.dropped!, 0);
  const jitterMs = intervals.flatMap((item) => item.jitterMs === null ? [] : [item.jitterMs]);
  const decodedFps = intervals.flatMap((item) => item.decodedFps === null ? [] : [item.decodedFps]);
  context.metadata.webrtc = { browser: version, peers: 2, separateBrowserProcesses: true,
    syntheticSource: "animated canvas", sourceWidth: 1280, sourceHeight: 720, requestedSourceFps: 30,
    secondsPerRun: context.mediaSeconds, runs: context.mediaRuns, requestedRelay: relay,
    selectedPaths: [...new Map(paths.map((path) => [JSON.stringify(path), path])).values()] };
  const common = { scope, notes: ["Synthetic video and same-host peers; do not label these values as real-user WAN or cross-region performance."] };
  add(context, {
    ...common, id: "M11", name: "WebRTC media establishment latency", component: "WebRTC / ICE / DTLS / SRTP",
    status: setupMs.length === context.mediaRuns && !errors.length ? "passed" : "failed",
    values: { setupMs: summarize(setupMs), attemptedRuns: context.mediaRuns, establishedRuns: setupMs.length, errors },
    samples: { setupMs }, notes: [...common.notes, "From offer request to both connected peers, first decoded video, and a data-channel echo. Browser launch and room join excluded."]
  });
  add(context, {
    ...common, id: "M12", name: "Selected ICE path round-trip time", component: "WebRTC transport",
    status: rttMs.length ? "passed" : "unavailable", values: { rttMs: summarize(rttMs) }, samples: { pathRttMs: rttMs },
    notes: [...common.notes, "Browser candidate-pair currentRoundTripTime in milliseconds; not one-way media latency or glass-to-glass delay. Repeated getStats observations are correlated."]
  });
  add(context, {
    ...common, id: "M13", name: "Video RTP packet loss and jitter", component: "RTP / SRTP media",
    status: received > 0 && packetIntervals.length && jitterMs.length ? "passed" : "unavailable",
    values: { receivedPackets: received, lostPacketsEstimate: lost, packetLossPercent: percentage(lost, received + lost),
      jitterMs: summarize(jitterMs), validIntervals: packetIntervals.length, ignoredCounterIntervals: intervals.length - packetIntervals.length,
      latePacketLossCorrections: packetIntervals.reduce((sum, item) => sum + (item.lateLossCorrection ?? 0), 0),
      rawCounterSnapshots: snapshots },
    samples: { jitterMs },
    notes: [...common.notes, "Loss = sum(max(0, delta packetsLost)) / (sum(delta packetsReceived) + sum(max(0, delta packetsLost))).",
      "Late-arrival negative loss deltas are retained as corrections; reset/missing counters are excluded. This is an interval estimate, not proof of zero lifetime loss."]
  });
  add(context, {
    ...common, id: "M14", name: "Receiver video frame drops and decoded FPS", component: "Video decoding / rendering pipeline",
    status: decoded > 0 && decodedFps.length ? "passed" : "unavailable",
    values: { decodedFrames: decoded, droppedFrames: dropped,
      decodeDropPercent: percentage(dropped, decoded + dropped), decodedFps: summarize(decodedFps),
      validIntervals: frameIntervals.length, intervals },
    samples: { decodedFps },
    notes: [...common.notes, "Drop ratio uses delta framesDropped / (delta framesDecoded + delta framesDropped).",
      "This measures receiver-reported drops, not every frame captured/sent/missing before reception. FPS = delta framesDecoded / stats timestamp delta seconds."]
  });
  add(context, {
    ...common, id: "M15", name: "Controlled ICE restart recovery", component: "IceRecovery / reliable signaling",
    status: recoveryMs.length === context.mediaRuns ? "passed" : "failed",
    values: { recoveryMs: summarize(recoveryMs), attemptedRuns: context.mediaRuns, recoveredRuns: recoveryMs.length, errors },
    samples: { recoveryMs },
    notes: [...common.notes, "Runs the real IceRecovery class, requires changed ICE credentials, a stable answered negotiation, connected ICE, and a data echo.",
      "A deliberate ICE restart on a working path; does not simulate physical Wi-Fi/cellular handover, offline time, or a blackholed network."]
  });
}
