import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { performance } from "node:perf_hooks";
import { add, measure, summarize, warmup, type Context } from "./common";

export function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; ca?: Buffer } = {}) {
  const target = new URL(url);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const outgoing = transport.request(target, {
      method: options.method ?? "GET", headers: options.headers,
      ca: options.ca, rejectUnauthorized: true, timeout: 10_000
    }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => { body += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
      incoming.on("error", reject);
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("HTTP request timed out")));
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}
export async function httpMetrics(context: Context) {
  const operation = async () => {
    const response = await request(new URL("/api/health", context.httpUrl).href, { ca: context.ca });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).service, "podcazt-web");
  };
  await warmup(context.warmup, operation);
  const result = await measure(context.samples, operation, context.concurrency);
  const { rawMs, ...values } = result;
  add(context, {
    id: "M01", name: "HTTP health latency and throughput", component: "Next.js / HTTPS",
    scope: new URL(context.httpUrl).origin, status: result.errors.length ? "failed" : "passed",
    values: { ...values, concurrency: context.concurrency, warmedRequests: context.warmup },
    samples: { requestMs: rawMs },
    notes: ["Request start through complete JSON response; not a database query or one-way network latency. HTTP connections may be reused."]
  });
}
export async function tlsMetrics(context: Context) {
  const target = new URL(context.httpUrl);
  if (target.protocol !== "https:") {
    add(context, { id: "M02", name: "Verified TLS handshake", component: "TLS transport", scope: target.origin,
      status: "unavailable", values: {}, notes: ["Set METRICS_HTTP_URL to an HTTPS origin, or use the local TLS fixture."] });
    return;
  }
  const handshakes: number[] = [];
  const sessions = new Set<string>();
  const ciphers = new Set<string>();
  const errors: string[] = [];
  for (let index = 0; index < context.samples; index++) {
    try {
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        const socket = tls.connect({
          host: target.hostname, port: Number(target.port || 443),
          servername: target.hostname === "127.0.0.1" ? "localhost" : target.hostname,
          ca: context.ca, rejectUnauthorized: true, minVersion: "TLSv1.2"
        });
        socket.setTimeout(10_000, () => socket.destroy(new Error("TLS handshake timed out")));
        socket.once("error", reject);
        socket.once("secureConnect", () => {
          try {
            assert.equal(socket.authorized, true);
            assert.equal(socket.isSessionReused(), false);
            handshakes.push(performance.now() - start);
            sessions.add(socket.getProtocol() ?? "unknown");
            ciphers.add(socket.getCipher().standardName ?? socket.getCipher().name);
            socket.end(); resolve();
          } catch (error) { socket.destroy(); reject(error); }
        });
      });
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  add(context, {
    id: "M02", name: "Verified TLS handshake", component: "TLS transport", scope: target.origin,
    status: errors.length ? "failed" : "passed",
    values: { handshakeMs: summarize(handshakes), protocols: [...sessions], ciphers: [...ciphers],
      attempted: context.samples, successful: handshakes.length, errors, verification: "CA chain and hostname", sessionResumption: false },
    samples: { handshakeMs: handshakes },
    notes: ["Includes name resolution, TCP connect, and a fresh TLS handshake; excludes HTTP. Negotiated protocol is not an exhaustive server cipher audit."]
  });
}
