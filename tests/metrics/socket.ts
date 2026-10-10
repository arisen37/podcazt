import { WebSocket } from "ws";
import { createRealtimeToken } from "../../lib/realtime-token";
import type { SessionUser } from "../../lib/types";
import type { Context } from "./common";

export type Message = { type: string; peerId?: string; messageId?: string; payload?: Record<string, unknown>; [key: string]: unknown };
export class MetricsSocket {
  socket: WebSocket;
  private inbox: Message[] = [];
  private waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void; reject: (error: Error) => void }> = [];
  constructor(url: string) {
    this.socket = new WebSocket(url, { handshakeTimeout: 5000 });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Message;
      if (message.messageId) this.send({ type: "signal-ack", ackId: message.messageId });
      const match = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (match >= 0) this.waiters.splice(match, 1)[0].resolve(message);
      else this.inbox.push(message);
    });
    this.socket.on("error", () => this.rejectWaiters());
    this.socket.on("close", () => this.rejectWaiters());
  }
  private rejectWaiters() {
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Metrics WebSocket closed before expected message"));
  }
  send(message: object) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  wait(predicate: (message: Message) => boolean, timeoutMs = 5000) {
    const ready = this.inbox.findIndex(predicate);
    if (ready >= 0) return Promise.resolve(this.inbox.splice(ready, 1)[0]);
    return new Promise<Message>((resolve, reject) => {
      const waiter = { predicate, resolve: (message: Message) => { clearTimeout(timer); resolve(message); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("Metrics WebSocket message timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { this.socket.terminate(); resolve(); }, 1000);
      this.socket.once("close", () => { clearTimeout(timeout); resolve(); });
      this.socket.close();
    });
  }
}
export async function socketUrl(context: Context, user: SessionUser) {
  const url = new URL(context.signalingUrl);
  url.searchParams.set("token", context.realtimeTokens?.[user.id] ?? await createRealtimeToken(user));
  return url.href;
}
export async function connect(context: Context, user: SessionUser, roomId: string) {
  const client = new MetricsSocket(await socketUrl(context, user));
  try {
    const ready = await client.wait((message) => message.type === "ready");
    client.send({ type: "join", roomId });
    await client.wait((message) => message.type === "peers");
    return { client, peerId: ready.peerId! };
  } catch (error) { await client.close(); throw error; }
}
