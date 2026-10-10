export type ReliableMessage = { type: string; messageId?: string; ackId?: string; [key: string]: unknown };
const reliableTypes = new Set(["offer", "answer", "ice-candidate", "ice-restart"]);

/** Selective-repeat acknowledgements for negotiation messages on a live socket.
 * Reconnection creates fresh peers rather than replaying stale SDP/ICE state.
 */
export class ReliableSignaling {
  private pending = new Map<string, { message: ReliableMessage; attempts: number; sentAt: number }>();
  private received = new Set<string>();
  constructor(
    private transmit: (message: ReliableMessage) => void,
    private onFailure: (message: string) => void,
    private now = () => Date.now(),
    private id = () => crypto.randomUUID() as string
  ) {}

  send(message: ReliableMessage) {
    if (!reliableTypes.has(message.type)) { this.transmit(message); return; }
    if (this.pending.size >= 256) { this.onFailure("Signaling queue is full. Reconnect to the room."); return; }
    const messageId = this.id();
    this.pending.set(messageId, { message: { ...message, messageId }, attempts: 0, sentAt: 0 });
    this.tick();
  }

  receive(message: ReliableMessage) {
    if (message.type === "signal-ack") {
      if (typeof message.ackId === "string") this.pending.delete(message.ackId);
      this.tick();
      return true;
    }
    if (message.messageId && this.received.has(message.messageId)) {
      this.transmit({ type: "signal-ack", ackId: message.messageId });
      return true;
    }
    return false;
  }

  processed(message: ReliableMessage) {
    if (!message.messageId || !reliableTypes.has(message.type)) return;
    this.received.add(message.messageId);
    if (this.received.size > 2048) this.received.delete(this.received.values().next().value!);
    this.transmit({ type: "signal-ack", ackId: message.messageId });
  }

  tick() {
    const now = this.now();
    let active = Array.from(this.pending.values()).filter((item) => item.attempts > 0).length;
    for (const [id, item] of this.pending) {
      if (!item.attempts && active >= 8) continue;
      if (item.attempts && now - item.sentAt < Math.min(750 * 2 ** (item.attempts - 1), 4000)) continue;
      if (item.attempts >= 6) {
        this.pending.delete(id);
        active--;
        this.onFailure("A negotiation message was not acknowledged. Reconnect if the call does not recover.");
        continue;
      }
      if (!item.attempts) active++;
      item.attempts++;
      item.sentAt = now;
      this.transmit(item.message);
    }
  }

  clear() { this.pending.clear(); this.received.clear(); }
}
