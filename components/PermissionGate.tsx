"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function PermissionGate() {
  const router = useRouter();
  const params = useSearchParams();
  const roomId = params.get("roomId");
  const [state, setState] = useState<"idle" | "requesting" | "ready">("idle");
  const [error, setError] = useState("");

  async function requestPermissions() {
    if (!roomId) {
      setError("Missing room id");
      return;
    }

    setState("requesting");
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((track) => track.stop());
      await Promise.all([
        fetch("/api/allowCam", { method: "POST" }),
        fetch("/api/allowMic", { method: "POST" })
      ]);
      setState("ready");
      router.push(`/record/${roomId}`);
    } catch {
      setState("idle");
      setError("Camera and microphone permission are required before entering the room.");
    }
  }

  return (
    <section className="card formCard">
      <span className="pill">Permissions</span>
      <h1>Allow camera and microphone</h1>
      <p className="muted">
        Podcazt needs browser permission to preview and record your local stream. You can still toggle mic/camera inside the room.
      </p>
      {error && <div className="alert">{error}</div>}
      <button className="btn btnPrimary" onClick={requestPermissions} disabled={state === "requesting"}>
        {state === "requesting" ? "Requesting..." : state === "ready" ? "Opening room..." : "Allow permissions"}
      </button>
    </section>
  );
}
