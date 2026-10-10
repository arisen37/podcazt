type RecoveryPeer = Pick<RTCPeerConnection,
  "connectionState" | "iceConnectionState" | "signalingState" | "remoteDescription" |
  "localDescription"> & {
    createOffer: (options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>;
    setLocalDescription: (description?: RTCLocalSessionDescriptionInit) => Promise<void>;
  };

type RecoveryOptions = {
  canSignal: () => boolean;
  isOfferer: () => boolean;
  send: (message: { type: "offer" | "ice-restart"; payload?: RTCSessionDescriptionInit }) => void;
  onRecovering: () => void;
  onAttempt: () => void;
  onConnected: () => void;
  onFailed: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
};

/** One elected peer sends restart offers; either peer can request recovery. */
export class IceRecovery {
  private cancelTimer?: () => void;
  private recovering = false;
  private disposed = false;
  private running = false;
  private waiting = false;
  private attempts = 0;
  private deadline = 0;
  private generation = 0;
  private now: () => number;
  private schedule: NonNullable<RecoveryOptions["schedule"]>;

  constructor(private peer: RecoveryPeer, private options: RecoveryOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
  }

  request(delay = 0) {
    if (this.disposed) return;
    if (!this.recovering) {
      this.recovering = true;
      this.attempts = 0;
      this.deadline = this.now() + 45_000;
      this.options.onRecovering();
      this.arm(delay);
    } else if (this.waiting) {
      this.arm(delay);
    }
  }

  stateChanged() {
    if (this.disposed) return;
    if (this.peer.connectionState === "closed") { this.dispose(); return; }
    if (this.peer.connectionState === "connected" &&
        ["connected", "completed"].includes(this.peer.iceConnectionState)) {
      this.stop();
      this.options.onConnected();
    } else if (this.peer.connectionState === "failed" || this.peer.iceConnectionState === "failed") {
      this.request();
    } else if (this.peer.connectionState === "disconnected" || this.peer.iceConnectionState === "disconnected") {
      this.request(2_000);
    }
  }

  signalingChanged() {
    if (this.recovering && this.waiting && this.peer.signalingState === "stable") this.arm(0);
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }

  private stop() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.recovering = false;
    this.waiting = false;
    this.generation++;
  }

  private arm(delay: number) {
    if (this.disposed || !this.recovering) return;
    this.cancelTimer?.();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      void this.retry();
    }, delay);
  }

  private async retry() {
    if (this.disposed || !this.recovering) return;
    if (this.running) { this.arm(1_000); return; }
    // A restart can preserve the connected state throughout negotiation.
    if (this.attempts > 0 && this.peer.signalingState === "stable" &&
        this.peer.connectionState === "connected" &&
        ["connected", "completed"].includes(this.peer.iceConnectionState)) {
      this.stateChanged();
      return;
    }
    if (!this.options.canSignal()) {
      // Offline time should not consume the media recovery budget.
      this.deadline = this.now() + 45_000;
      this.waiting = true;
      this.arm(1_000);
      return;
    }
    if (this.attempts >= 3 || this.now() >= this.deadline) {
      this.stop();
      this.options.onFailed();
      return;
    }
    if (!this.peer.remoteDescription || this.peer.signalingState !== "stable") {
      this.waiting = true;
      this.arm(1_000);
      return;
    }
    this.waiting = false;
    this.running = true;
    const generation = this.generation;
    this.attempts++;
    try {
      if (this.options.isOfferer()) {
        this.options.onAttempt();
        const offer = await this.peer.createOffer({ iceRestart: true });
        if (this.disposed || generation !== this.generation || this.peer.signalingState !== "stable") return;
        await this.peer.setLocalDescription(offer);
        if (this.disposed || generation !== this.generation || !this.options.canSignal()) return;
        this.options.send({ type: "offer", payload: this.peer.localDescription ?? offer });
      } else {
        this.options.send({ type: "ice-restart" });
      }
    } catch {
      // Retry transient allocation/negotiation failures before reporting an error.
    } finally {
      this.running = false;
      if (generation === this.generation) this.arm(10_000);
    }
  }
}
