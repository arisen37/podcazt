"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getApiErrorMessage } from "@/lib/client-error";
import { getRealtimeToken, getSignalingUrl } from "@/lib/realtime-client";
import { clearRecordingChunks, getRecordingChunks, saveRecordingChunk } from "@/lib/recording-store";

type Participant = {
  peerId: string;
  name: string;
  username: string;
  stream?: MediaStream;
};

type SignalMessage = {
  type: string;
  peerId?: string;
  ownerId?: string;
  peers?: Array<{ peerId: string; user: { name: string; username: string } }>;
  user?: { name: string; username: string };
  payload?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  message?: string;
};

type RecorderProps = {
  roomId: string;
  isOwner: boolean;
  currentUser: { name: string; username: string };
  onParticipantsChange?: (participants: LiveParticipant[]) => void;
};

export type LiveParticipant = Pick<Participant, "peerId" | "name" | "username">;

type MediaStats = {
  encoded: number;
  sent: number;
  received: number;
  decoded: number;
  dropped: number;
  packetsLost: number;
};

type VideoRtpStats = RTCStats & Partial<MediaStats> & {
  kind?: string;
  mediaType?: string;
  framesEncoded?: number;
  framesSent?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  packetsLost?: number;
};

function normalizeTurnUrl(configuredUrl?: string) {
  const value = configuredUrl?.trim();
  if (!value) return null;

  const url = /^(?:turn|turns):/i.test(value)
    ? value
    : `turn:${value.replace(/^\/\//, "")}`;

  return /^(?:turn|turns):[^\s]+$/i.test(url) ? url : null;
}

async function sha256(blob: Blob) {
  const bytes = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function VideoTile({ participant, muted, attach }: {
  participant: Participant;
  muted?: boolean;
  attach: (peerId: string, element: HTMLVideoElement | null, stream?: MediaStream) => void;
}) {
  return (
    <article className="participantTile">
      <video
        ref={(element) => attach(participant.peerId, element, participant.stream)}
        autoPlay
        muted={muted}
        playsInline
      />
      {!participant.stream && <div className="participantWaiting">Connecting…</div>}
      <span className="participantName">{participant.name}{muted ? " (You)" : ""}</span>
    </article>
  );
}

export function Recorder({ roomId, isOwner, currentUser, onParticipantsChange }: RecorderProps) {
  const router = useRouter();
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const candidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const remoteStreamsRef = useRef(new Map<string, MediaStream>());
  const videoElementsRef = useRef(new Map<string, HTMLVideoElement>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingIdRef = useRef(crypto.randomUUID());
  const chunkCountRef = useRef(0);
  const pendingChunkWritesRef = useRef<Promise<void>>(Promise.resolve());
  const localWriteFailedRef = useRef(false);
  const uploadPromiseRef = useRef<Promise<boolean> | null>(null);
  const [localParticipant, setLocalParticipant] = useState<Participant>({
    peerId: "local",
    name: currentUser.name || currentUser.username,
    username: currentUser.username
  });
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connectionState, setConnectionState] = useState("Connecting…");
  const [recording, setRecording] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [ending, setEnding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [localChunksReady, setLocalChunksReady] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [error, setError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [mediaStats, setMediaStats] = useState<MediaStats>({
    encoded: 0,
    sent: 0,
    received: 0,
    decoded: 0,
    dropped: 0,
    packetsLost: 0
  });

  useEffect(() => {
    onParticipantsChange?.([localParticipant, ...participants].map(({ peerId, name, username }) => ({
      peerId,
      name,
      username
    })));
  }, [localParticipant, onParticipantsChange, participants]);

  const sendSignal = useCallback((message: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...message, roomId }));
  }, [roomId]);

  const removePeer = useCallback((peerId: string) => {
    peersRef.current.get(peerId)?.close();
    peersRef.current.delete(peerId);
    candidatesRef.current.delete(peerId);
    remoteStreamsRef.current.delete(peerId);
    videoElementsRef.current.delete(peerId);
    setParticipants((current) => current.filter((participant) => participant.peerId !== peerId));
  }, []);

  const createPeer = useCallback((peerId: string, user?: { name: string; username: string }) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;

    const configuredTurnUrl = process.env.NEXT_PUBLIC_TURN_URL;
    const turnUrl = normalizeTurnUrl(configuredTurnUrl);
    const iceServers: RTCIceServer[] = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ];
    if (turnUrl) {
      iceServers.push({
        urls: turnUrl,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL
      });
    }
    if (configuredTurnUrl && !turnUrl) {
      setError("The configured TURN relay URL is invalid. Check NEXT_PUBLIC_TURN_URL.");
    }
    const peer = new RTCPeerConnection({ iceServers });
    streamRef.current?.getTracks().forEach((track) => peer.addTrack(track, streamRef.current as MediaStream));
    peer.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: "ice-candidate", targetPeerId: peerId, payload: event.candidate });
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? remoteStreamsRef.current.get(peerId) ?? new MediaStream();
      if (!event.streams[0] && !stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track);
      }
      remoteStreamsRef.current.set(peerId, stream);
      setParticipants((current) => current.map((participant) =>
        participant.peerId === peerId ? { ...participant, stream } : participant
      ));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        setError("Could not establish a media path to a participant. Check the TURN relay configuration.");
      }
      if (peer.connectionState === "closed") removePeer(peerId);
    };
    peersRef.current.set(peerId, peer);
    setParticipants((current) => current.some((participant) => participant.peerId === peerId)
      ? current
      : [...current, { peerId, name: user?.name || "Guest", username: user?.username || "guest" }]
    );
    return peer;
  }, [removePeer, sendSignal]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    const peerConnections = peersRef.current;
    const remoteStreams = remoteStreamsRef.current;

    async function connect() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires HTTPS or localhost");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setLocalParticipant((participant) => ({ ...participant, stream }));

        const token = await getRealtimeToken();
        socket = new WebSocket(getSignalingUrl(token));
        socketRef.current = socket;
        socket.onopen = () => setConnectionState("Authenticating…");
        socket.onmessage = async (event) => {
          try {
            const message = JSON.parse(String(event.data)) as SignalMessage;
            if (message.type === "ready") {
              setConnectionState("Joining…");
              sendSignal({ type: "join" });
              return;
            }
            if (message.type === "error") {
              setError(message.message || "Realtime connection failed");
              setConnectionState("Room unavailable");
              return;
            }
            if (message.type === "room-ended") {
              router.push("/ended");
              return;
            }
            if (message.type === "peers") {
              setConnectionState("Live");
              for (const remote of message.peers ?? []) {
                createPeer(remote.peerId, remote.user);
              }
              return;
            }
            if (message.type === "peer-joined" && message.peerId) {
              if (peersRef.current.has(message.peerId)) return;
              const peer = createPeer(message.peerId, message.user);
              const offer = await peer.createOffer();
              await peer.setLocalDescription(offer);
              sendSignal({ type: "offer", targetPeerId: message.peerId, payload: offer });
              return;
            }
            if (message.type === "peer-left" && message.peerId) {
              removePeer(message.peerId);
              return;
            }
            if (!message.peerId) return;
            const peer = createPeer(message.peerId, message.user);
            if (message.type === "offer") {
              await peer.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
              const answer = await peer.createAnswer();
              await peer.setLocalDescription(answer);
              sendSignal({ type: "answer", targetPeerId: message.peerId, payload: answer });
            } else if (message.type === "answer") {
              await peer.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
            } else if (message.type === "ice-candidate") {
              const candidate = message.payload as RTCIceCandidateInit;
              if (peer.remoteDescription) await peer.addIceCandidate(candidate);
              else candidatesRef.current.set(message.peerId, [...(candidatesRef.current.get(message.peerId) ?? []), candidate]);
            }

            if (peer.remoteDescription) {
              for (const candidate of candidatesRef.current.get(message.peerId) ?? []) await peer.addIceCandidate(candidate);
              candidatesRef.current.delete(message.peerId);
            }
          } catch (caught) {
            setError(caught instanceof Error ? `WebRTC negotiation failed: ${caught.message}` : "WebRTC negotiation failed.");
          }
        };
        socket.onerror = () => setError("Could not connect to the realtime server.");
        socket.onclose = () => {
          if (active) setConnectionState("Disconnected");
        };
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not access camera/microphone.");
        setConnectionState("Offline");
      }
    }

    void connect();
    return () => {
      active = false;
      socket?.close(1000, "Page closed");
      peerConnections.forEach((peer) => peer.close());
      peerConnections.clear();
      remoteStreams.clear();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      void audioContextRef.current?.close();
    };
  }, [createPeer, removePeer, router, sendSignal]);

  useEffect(() => {
    const peerConnections = peersRef.current;
    const interval = window.setInterval(() => {
      void Promise.all(Array.from(peerConnections.values(), (peer) => peer.getStats()))
        .then((reports) => {
          const next: MediaStats = { encoded: 0, sent: 0, received: 0, decoded: 0, dropped: 0, packetsLost: 0 };
          reports.forEach((report) => report.forEach((rawStat) => {
            const stat = rawStat as VideoRtpStats;
            if (stat.kind !== "video" && stat.mediaType !== "video") return;
            if (stat.type === "outbound-rtp") {
              next.encoded += stat.framesEncoded ?? 0;
              next.sent += stat.framesSent ?? stat.framesEncoded ?? 0;
            }
            if (stat.type === "inbound-rtp") {
              next.received += stat.framesReceived ?? stat.framesDecoded ?? 0;
              next.decoded += stat.framesDecoded ?? 0;
              next.dropped += stat.framesDropped ?? 0;
              next.packetsLost += Math.max(0, stat.packetsLost ?? 0);
            }
          }));
          setMediaStats(next);
        })
        .catch(() => undefined);
    }, 2_000);

    return () => window.clearInterval(interval);
  }, []);

  const attachVideo = useCallback((peerId: string, element: HTMLVideoElement | null, stream?: MediaStream) => {
    if (!element) {
      videoElementsRef.current.delete(peerId);
      return;
    }
    videoElementsRef.current.set(peerId, element);
    if (stream && element.srcObject !== stream) {
      element.srcObject = stream;
      if (peerId !== "local") {
        void element.play()
          .catch(() => setAudioBlocked(true));
      }
    }
  }, []);

  async function enableParticipantAudio() {
    const remoteVideos = Array.from(videoElementsRef.current.entries())
      .filter(([peerId]) => peerId !== "local")
      .map(([, video]) => video);
    const results = await Promise.allSettled(remoteVideos.map((video) => video.play()));
    setAudioBlocked(results.some((result) => result.status === "rejected"));
  }

  function drawCompositeFrame(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return;
    const videos = Array.from(videoElementsRef.current.values()).filter((video) => video.readyState >= 2);
    context.fillStyle = "#080808";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const count = Math.max(videos.length, 1);
    const columns = count <= 2 ? count : 2;
    const rows = Math.ceil(count / columns);
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;

    videos.forEach((video, index) => {
      const x = (index % columns) * cellWidth;
      const y = Math.floor(index / columns) * cellHeight;
      const scale = Math.max(cellWidth / video.videoWidth, cellHeight / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      context.drawImage(video, x + (cellWidth - width) / 2, y + (cellHeight - height) / 2, width, height);
    });
  }

  function createCompositeStream() {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    compositeCanvasRef.current = canvas;
    const render = () => {
      drawCompositeFrame(canvas);
      animationFrameRef.current = requestAnimationFrame(render);
    };
    render();

    const combined = canvas.captureStream(30);
    const AudioContextConstructor = window.AudioContext;
    const audioContext = new AudioContextConstructor();
    audioContextRef.current = audioContext;
    const destination = audioContext.createMediaStreamDestination();
    const streams = [streamRef.current, ...participants.map((participant) => participant.stream)].filter(Boolean) as MediaStream[];
    streams.forEach((stream) => {
      if (stream.getAudioTracks().length) audioContext.createMediaStreamSource(stream).connect(destination);
    });
    destination.stream.getAudioTracks().forEach((track) => combined.addTrack(track));
    recorderStreamRef.current = combined;
    return combined;
  }

  async function startRecording() {
    if (!isOwner) return;
    if (!streamRef.current) {
      setError("No media stream is available.");
      return;
    }
    setError("");
    setUploadState("Preparing local recording storage…");
    uploadPromiseRef.current = null;
    setLocalChunksReady(false);
    const recordingId = crypto.randomUUID();
    recordingIdRef.current = recordingId;
    chunkCountRef.current = 0;
    localWriteFailedRef.current = false;
    pendingChunkWritesRef.current = Promise.resolve();
    try {
      await clearRecordingChunks(recordingId);
    } catch {
      setError("Local recording storage is unavailable. Recording was not started.");
      setUploadState("");
      return;
    }
    const stream = createCompositeStream();
    const preferredType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const chunkIndex = chunkCountRef.current;
      chunkCountRef.current += 1;
      pendingChunkWritesRef.current = pendingChunkWritesRef.current
        .then(() => saveRecordingChunk(recordingId, chunkIndex, event.data))
        .catch((caught) => {
          localWriteFailedRef.current = true;
          setError(caught instanceof Error ? caught.message : "A recording chunk could not be saved locally.");
        });
    };
    recorder.start(2000);
    recorderRef.current = recorder;
    setUploadState("Recording locally…");
    setRecording(true);
  }

  function stopCompositeCapture() {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    recorderStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  async function stopRecordingAndUpload() {
    if (uploadPromiseRef.current) return uploadPromiseRef.current;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return false;

    setUploadState("Finalizing recording…");
    setUploading(true);
    setRecording(false);
    const uploadPromise = new Promise<boolean>((resolve) => {
      recorder.onstop = () => {
        stopCompositeCapture();
        void pendingChunkWritesRef.current.then(() => {
          if (localWriteFailedRef.current) {
            setUploadState("Local recording is incomplete. Upload stopped.");
            setUploading(false);
            resolve(false);
            return;
          }
          void uploadChunks()
            .then(resolve)
            .catch(() => resolve(false))
            .finally(() => setUploading(false));
        });
      };
      recorder.stop();
    });
    uploadPromiseRef.current = uploadPromise;
    return uploadPromise;
  }

  async function uploadChunks() {
    const recordingId = recordingIdRef.current;
    const chunks = await getRecordingChunks(recordingId);
    if (chunks.length === 0 || chunks.every((chunk) => chunk.blob.size === 0)) {
      setUploadState("Nothing was recorded.");
      return false;
    }
    setLocalChunksReady(true);
    if (chunks.some((chunk, index) => chunk.chunkIndex !== index)) {
      setError("The local recording has a missing chunk. Upload stopped.");
      return false;
    }
    setUploadState(`Uploading 0/${chunks.length}`);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index].blob;
      const hash = await sha256(chunk);
      const form = new FormData();
      form.set("recordingId", recordingId);
      form.set("roomId", roomId);
      form.set("chunkIndex", String(index));
      form.set("totalChunks", String(chunks.length));
      form.set("sha256", hash);
      form.set("file", chunk, `${index}.webm`);
      const response = await fetch("/api/record", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.sha256 !== hash) {
        setError(getApiErrorMessage(body, `Chunk ${index + 1} failed verification.`));
        return false;
      }
      setUploadState(`Uploading ${index + 1}/${chunks.length}`);
    }

    const response = await fetch("/api/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingId, roomId, totalChunks: chunks.length })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(getApiErrorMessage(body, "Final upload assembly failed."));
      return false;
    }
    if (typeof body.videoId === "string") await uploadFrame(body.videoId);
    try {
      await clearRecordingChunks(recordingId);
    } catch {
      setLocalChunksReady(false);
      setUploadState("Recording saved. Local chunk cleanup will be retried later.");
      return true;
    }
    setLocalChunksReady(false);
    setUploadState("Recording saved.");
    return true;
  }

  async function retryLocalUpload() {
    if (uploading) return;
    setError("");
    setUploading(true);
    const uploadPromise = uploadChunks().catch(() => false).finally(() => setUploading(false));
    uploadPromiseRef.current = uploadPromise;
    await uploadPromise;
  }

  async function uploadFrame(videoId: string) {
    const canvas = compositeCanvasRef.current;
    if (!canvas) return;
    drawCompositeFrame(canvas);
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!frame) return;
    const form = new FormData();
    form.set("roomId", roomId);
    form.set("videoId", videoId);
    form.set("file", frame, "frame.jpg");
    const response = await fetch("/api/frame", { method: "POST", body: form });
    if (!response.ok) setError(getApiErrorMessage(await response.json().catch(() => ({})), "Preview upload failed."));
  }

  function toggleMic() {
    const next = !micOn;
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    setMicOn(next);
  }

  function toggleCam() {
    const next = !camOn;
    streamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; });
    setCamOn(next);
  }

  async function shareScreen() {
    if (!isOwner) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = display.getVideoTracks()[0];
      if (!screenTrack) return;
      const originalTrack = streamRef.current?.getVideoTracks()[0];
      const displayStream = new MediaStream([screenTrack, ...(streamRef.current?.getAudioTracks() ?? [])]);
      peersRef.current.forEach((peer) => void peer.getSenders().find((sender) => sender.track?.kind === "video")?.replaceTrack(screenTrack));
      const localVideo = videoElementsRef.current.get("local");
      setLocalParticipant((participant) => ({ ...participant, stream: displayStream }));
      if (localVideo) localVideo.srcObject = displayStream;
      screenTrack.onended = () => {
        if (originalTrack) peersRef.current.forEach((peer) => void peer.getSenders().find((sender) => sender.track?.kind === "video")?.replaceTrack(originalTrack));
        setLocalParticipant((participant) => ({ ...participant, stream: streamRef.current ?? undefined }));
        if (localVideo) localVideo.srcObject = streamRef.current;
      };
    } catch {
      setError("Screen sharing was cancelled or blocked.");
    }
  }

  async function endCall() {
    setEnding(true);
    setError("");
    if (isOwner && recording) {
      const saved = await stopRecordingAndUpload();
      if (!saved && chunkCountRef.current > 0) {
        setEnding(false);
        return;
      }
    } else if (isOwner && uploadPromiseRef.current) {
      const saved = await uploadPromiseRef.current;
      if (!saved && chunkCountRef.current > 0) {
        setError("The local recording has not uploaded yet. Retry the upload before ending the room.");
        setEnding(false);
        return;
      }
    }
    sendSignal({ type: isOwner ? "end-room" : "leave" });
    await fetch("/api/leaveCall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId })
    }).catch(() => undefined);
    router.push("/ended");
  }

  return (
    <section className="card stage realtimeStage">
      <div className={`participantGrid participantCount${participants.length + 1}`}>
        <VideoTile participant={localParticipant} muted attach={attachVideo} />
        {participants.map((participant) => <VideoTile key={participant.peerId} participant={participant} attach={attachVideo} />)}
      </div>
      <div className="controls">
        {isOwner && (
          <button className={`btn ${recording ? "btnDanger" : "btnPrimary"}`} onClick={recording ? () => void stopRecordingAndUpload() : () => void startRecording()} disabled={ending}>
            {recording ? "Stop recording" : "Record"}
          </button>
        )}
        {isOwner && !recording && localChunksReady && (
          <button className="btn btnPrimary" onClick={() => void retryLocalUpload()} disabled={ending || uploading}>
            {uploading ? "Uploading…" : "Retry saved upload"}
          </button>
        )}
        <button className="btn" onClick={toggleMic} disabled={ending}>{micOn ? "Mute mic" : "Unmute mic"}</button>
        <button className="btn" onClick={toggleCam} disabled={ending}>{camOn ? "Turn camera off" : "Turn camera on"}</button>
        {audioBlocked && (
          <button className="btn btnPrimary" onClick={() => void enableParticipantAudio()} disabled={ending}>
            Enable participant audio
          </button>
        )}
        {isOwner && <button className="btn" onClick={shareScreen} disabled={ending}>Share screen</button>}
        <button className="btn btnDanger" onClick={endCall} disabled={ending}>
          {ending ? "Leaving…" : isOwner ? "End room" : "Leave room"}
        </button>
        <span className={`pill connectionPill ${connectionState === "Live" ? "live" : ""}`}>{connectionState}</span>
        {participants.length > 0 && (
          <span className="pill mediaStats" title="WebRTC video frame transport counters">
            Frames ↑ {mediaStats.sent}/{mediaStats.encoded} · ↓ {mediaStats.received}/{mediaStats.decoded}
            {mediaStats.dropped > 0 || mediaStats.packetsLost > 0
              ? ` · dropped ${mediaStats.dropped}, packets lost ${mediaStats.packetsLost}`
              : " · no reported loss"}
          </span>
        )}
        {uploadState && <span className="pill">{uploadState}</span>}
        {error && <div className="alert">{error}</div>}
      </div>
    </section>
  );
}
