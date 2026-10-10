import { IceRecovery } from "../../lib/ice-recovery";
import { ReliableSignaling, type ReliableMessage } from "../../lib/reliable-signaling";
import type { StatsRow } from "./webrtc-stats";

type Settings = { socketUrl: string; roomId: string; remoteUserId: string; offerer: boolean; iceServers: RTCIceServer[]; relay: boolean };
class MetricsPeer {
  pc!: RTCPeerConnection;
  socket!: WebSocket;
  channel?: RTCDataChannel;
  target = "";
  ready = false;
  error?: string;
  receivedTypes: string[] = [];
  iceErrors: Array<{ code: number; text: string }> = [];
  private reliability!: ReliableSignaling;
  private recovery!: IceRecovery;
  private candidates: RTCIceCandidateInit[] = [];
  private ticks?: ReturnType<typeof setInterval>;
  private draw?: ReturnType<typeof setInterval>;
  private stream?: MediaStream;
  private chain = Promise.resolve();
  private settings!: Settings;
  private pingWaiters = new Map<string, () => void>();
  private restartAt = 0;
  private restartMs: number | null = null;
  private restartOldUfrag = "";
  private restartOfferChanged = false;

  start(settings: Settings) {
    this.settings = settings;
    this.pc = new RTCPeerConnection({ iceServers: settings.iceServers, iceTransportPolicy: settings.relay ? "relay" : "all" });
    const video = document.createElement("video");
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.width = 640; video.height = 360;
    document.body.append(video);
    this.pc.ontrack = (event) => { video.srcObject = event.streams[0]; void video.play().catch(() => {}); };
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720; document.body.append(canvas);
    const paint = canvas.getContext("2d")!;
    let frame = 0;
    const draw = () => {
      frame++;
      paint.fillStyle = "hsl(" + frame % 360 + ",60%,40%)";
      paint.fillRect(0, 0, canvas.width, canvas.height);
      paint.fillStyle = "white"; paint.fillRect(frame * 11 % 1100, frame * 7 % 550, 180, 170);
      paint.font = "32px sans-serif"; paint.fillText("Synthetic metrics frame " + frame, 30, 50);
    };
    draw(); this.draw = setInterval(draw, 1000 / 30);
    this.stream = canvas.captureStream(30);
    for (const track of this.stream.getTracks()) this.pc.addTrack(track, this.stream);
    this.pc.ondatachannel = (event) => this.setChannel(event.channel);
    if (settings.offerer) this.setChannel(this.pc.createDataChannel("metrics"));
    this.socket = new WebSocket(settings.socketUrl);
    this.reliability = new ReliableSignaling(
      (message) => { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); },
      (message) => { this.error = message; }
    );
    this.ticks = setInterval(() => this.reliability.tick(), 100);
    this.recovery = new IceRecovery(this.pc, {
      canSignal: () => this.socket.readyState === WebSocket.OPEN, isOfferer: () => settings.offerer,
      send: (message) => {
        if (message.type === "offer") {
          const next = /a=ice-ufrag:([^\r\n]+)/.exec(message.payload?.sdp ?? "")?.[1];
          this.restartOfferChanged = Boolean(next && next !== this.restartOldUfrag);
        }
        this.send(message);
      },
      onRecovering: () => {}, onAttempt: () => {}, onConnected: () => {},
      onFailed: () => { this.error = "ICE recovery budget exhausted"; }
    });
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.target) this.send({ type: "ice-candidate", payload: event.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => this.recovery.stateChanged();
    this.pc.onicecandidateerror = (event) => { this.iceErrors.push({ code: event.errorCode, text: event.errorText }); };
    this.pc.oniceconnectionstatechange = () => this.recovery.stateChanged();
    this.pc.onsignalingstatechange = () => this.recovery.signalingChanged();
    this.socket.onmessage = (event) => {
      this.chain = this.chain.then(async () => {
        const message = JSON.parse(event.data) as ReliableMessage;
        this.receivedTypes.push(message.type);
        if (this.reliability.receive(message)) return;
        if (message.type === "ready") this.socket.send(JSON.stringify({ type: "join", roomId: settings.roomId }));
        if (message.type === "peers") {
          const peers = message.peers as Array<{ peerId: string; user: { id: string } }>;
          this.target = peers.filter((peer) => peer.user.id === settings.remoteUserId).at(-1)?.peerId ?? ""; this.ready = true;
        }
        if (message.type === "peer-joined" && (message.user as { id?: string })?.id === settings.remoteUserId) this.target = String(message.peerId);
        if (message.type === "offer" || message.type === "answer") {
          // Reply to the actual authenticated sender, even if a previous trial's
          // socket has not yet disappeared from the room roster.
          this.target = String(message.peerId);
          await this.pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          for (const candidate of this.candidates.splice(0)) await this.pc.addIceCandidate(candidate);
          if (message.type === "offer") {
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            this.send({ type: "answer", payload: this.pc.localDescription });
          }
        }
        if (message.type === "ice-candidate") {
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.payload as RTCIceCandidateInit);
          else this.candidates.push(message.payload as RTCIceCandidateInit);
        }
        if (message.type === "ice-restart") this.recovery.request();
        if (message.type === "error") this.error = String(message.message);
        this.reliability.processed(message);
      }).catch((error: Error) => { this.error = error.message; });
    };
    this.socket.onerror = () => { this.error = "Benchmark WebSocket failed"; };
  }
  private send(message: { type: string; payload?: unknown }) {
    this.reliability.send({ ...message, roomId: this.settings.roomId, targetPeerId: this.target });
  }
  private setChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.onmessage = (event) => {
      const message = String(event.data);
      if (message.startsWith("echo:")) { this.pingWaiters.get(message.slice(5))?.(); this.pingWaiters.delete(message.slice(5)); }
      else channel.send("echo:" + message);
    };
  }
  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.send({ type: "offer", payload: this.pc.localDescription });
  }
  connected() {
    return !this.error && this.pc.connectionState === "connected" && this.channel?.readyState === "open";
  }
  async ping() {
    if (this.channel?.readyState !== "open") throw new Error("Metrics channel is not open");
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pingWaiters.delete(id); reject(new Error("Data channel echo timed out")); }, 5000);
      this.pingWaiters.set(id, () => { clearTimeout(timer); resolve(); });
      this.channel!.send(id);
    });
  }
  async stats(): Promise<StatsRow[]> {
    const report = await this.pc.getStats();
    const fields = ["id", "type", "timestamp", "kind", "mediaType", "packetsReceived", "packetsLost",
      "jitter", "framesDecoded", "framesDropped", "frameWidth", "frameHeight", "selectedCandidatePairId",
      "localCandidateId", "remoteCandidateId", "candidateType", "protocol", "relayProtocol",
      "currentRoundTripTime", "state", "nominated"];
    return Array.from(report.values()).filter((row) => ["inbound-rtp", "transport", "candidate-pair", "local-candidate", "remote-candidate"].includes(row.type))
      .map((row) => Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])) as StatsRow);
  }
  restart() {
    this.restartMs = null; this.restartOfferChanged = false;
    this.restartOldUfrag = /a=ice-ufrag:([^\r\n]+)/.exec(this.pc.localDescription?.sdp ?? "")?.[1] ?? "";
    this.restartAt = performance.now();
    this.recovery.request();
  }
  async recoveryResult() {
    // Require changed ICE credentials, a completed answer, connected ICE, and a data echo.
    if (this.restartMs === null && this.restartOfferChanged && this.pc.signalingState === "stable" && this.connected()
      && ["connected", "completed"].includes(this.pc.iceConnectionState)) {
      await this.ping(); this.restartMs = performance.now() - this.restartAt;
    }
    return this.restartMs;
  }
  close() {
    clearInterval(this.ticks); clearInterval(this.draw);
    this.recovery?.dispose(); this.reliability?.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.pc?.close(); this.socket?.close();
  }
}
declare global { interface Window { metricPeer: MetricsPeer; } }
window.metricPeer = new MetricsPeer();
