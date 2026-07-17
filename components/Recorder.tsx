"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getApiErrorMessage } from "@/lib/client-error";

type RecorderProps = {
  roomId: string;
};

async function sha256(blob: Blob) {
  const bytes = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getErrorText(body: unknown, fallback: string) {
  return getApiErrorMessage(body, fallback);
}

export function Recorder({ roomId }: RecorderProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const uploadPromiseRef = useRef<Promise<boolean> | null>(null);
  const [recordingId] = useState(() => crypto.randomUUID());
  const [recording, setRecording] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [handRaised, setHandRaised] = useState(false);
  const [ending, setEnding] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .then((stream) => {
        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setError("Could not access camera/microphone."));

    return () => {
      mounted = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function sendControl(control: string, enabled?: boolean) {
    await fetch(`/api/${control}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, enabled })
    }).catch(() => undefined);
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) {
      setError("No media stream is available.");
      return;
    }
    setError("");
    setUploadState("");
    uploadPromiseRef.current = null;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.start(2000);
    recorderRef.current = recorder;
    setRecording(true);
  }

  async function stopRecordingAndUpload() {
    if (uploadPromiseRef.current) return uploadPromiseRef.current;

    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      const uploadPromise = uploadChunks();
      uploadPromiseRef.current = uploadPromise;
      return uploadPromise;
    }

    setUploadState("Finalizing recording...");
    setRecording(false);
    const uploadPromise = new Promise<boolean>((resolve) => {
      recorder.onstop = () => {
        const promise = uploadChunks();
        uploadPromiseRef.current = promise;
        promise.then(resolve).catch(() => resolve(false));
      };
      recorder.stop();
    });

    uploadPromiseRef.current = uploadPromise;
    return uploadPromise;
  }

  async function uploadChunks() {
    const chunks = chunksRef.current;
    if (chunks.length === 0) {
      setUploadState("No recording chunks captured.");
      return true;
    }
    setUploadState(`Uploading 0/${chunks.length}`);

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
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
        setError(getApiErrorMessage(body, `Chunk ${index + 1} failed verification. Upload stopped.`));
        return false;
      }
      setUploadState(`Uploading ${index + 1}/${chunks.length}`);
    }

    const complete = await fetch("/api/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingId, roomId, totalChunks: chunks.length })
    });
    const completionBody = await complete.json().catch(() => ({}));

    if (!complete.ok) {
      setError(getErrorText(completionBody, "Final upload assembly failed."));
      return false;
    }

    const videoId = typeof completionBody.videoId === "string" ? completionBody.videoId : "";
    if (videoId) {
      const frameSaved = await uploadFrame(videoId);
      if (!frameSaved) return false;
    }

    setUploadState("Recording saved.");
    return true;
  }

  async function captureFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;

    const width = video.videoWidth || video.clientWidth;
    const height = video.videoHeight || video.clientHeight;
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    context.drawImage(video, 0, 0, width, height);

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  async function uploadFrame(videoId: string) {
    setUploadState("Saving preview frame...");
    const frame = await captureFrame();
    if (!frame) {
      setUploadState("Recording saved. Preview frame was not available.");
      return true;
    }

    const form = new FormData();
    form.set("roomId", roomId);
    form.set("videoId", videoId);
    form.set("recordingId", recordingId);
    form.set("file", frame, "frame.png");

    const response = await fetch("/api/frame", {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(getErrorText(body, "Frame upload failed."));
      return false;
    }

    return true;
  }

  function toggleMic() {
    const next = !micOn;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    setMicOn(next);
    void sendControl("mic", next);
  }

  function toggleCam() {
    const next = !camOn;
    streamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
    setCamOn(next);
    void sendControl("cam", next);
  }

  async function shareScreen() {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const videoTrack = screen.getVideoTracks()[0];
      const stream = streamRef.current;
      if (!stream || !videoTrack) return;
      stream.getVideoTracks().forEach((track) => stream.removeTrack(track));
      stream.addTrack(videoTrack);
      if (videoRef.current) videoRef.current.srcObject = stream;
      await sendControl("shareScreen", true);
    } catch {
      setError("Screen sharing was cancelled or blocked.");
    }
  }

  async function endCall() {
    setEnding(true);
    setError("");

    if (recording || recorderRef.current?.state === "recording") {
      const saved = await stopRecordingAndUpload();
      if (!saved) {
        setEnding(false);
        return;
      }
    } else if (uploadPromiseRef.current) {
      const saved = await uploadPromiseRef.current;
      if (!saved) {
        setEnding(false);
        return;
      }
    }

    await fetch("/api/leaveCall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId })
    }).catch(() => undefined);
    router.push("/ended");
  }

  return (
    <section className="card stage">
      <video className="preview" ref={videoRef} autoPlay muted playsInline />
      <div className="controls">
        <button
          className={`btn ${recording ? "btnDanger" : "btnPrimary"}`}
          onClick={recording ? () => void stopRecordingAndUpload() : startRecording}
          disabled={ending}
        >
          {recording ? "Stop" : "Record"}
        </button>
        <button className="btn" onClick={toggleMic} disabled={ending}>{micOn ? "Mic on" : "Mic off"}</button>
        <button className="btn" onClick={toggleCam} disabled={ending}>{camOn ? "Cam on" : "Cam off"}</button>
        <button
          className="btn"
          disabled={ending}
          onClick={() => {
            setHandRaised((value) => !value);
            void sendControl("raiseHand", !handRaised);
          }}
        >
          {handRaised ? "Lower hand" : "Raise hand"}
        </button>
        <button className="btn" onClick={shareScreen} disabled={ending}>Share screen</button>
        <button className="btn btnDanger" onClick={endCall} disabled={ending}>
          {ending ? "Ending..." : "End call"}
        </button>
        {uploadState && <span className="pill">{uploadState}</span>}
        {error && <div className="alert">{error}</div>}
      </div>
    </section>
  );
}
