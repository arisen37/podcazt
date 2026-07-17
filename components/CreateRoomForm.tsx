"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getApiErrorMessage } from "@/lib/client-error";

export function CreateRoomForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<"podcast" | "self-record" | null>(null);

  async function create(event: FormEvent<HTMLFormElement>, kind: "podcast" | "self-record") {
    event.preventDefault();
    setError("");
    setLoading(kind);
    const form = new FormData(event.currentTarget);
    const endpoint = kind === "podcast" ? "/api/podcast" : "/api/self-record";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ RoomName: String(form.get("RoomName") || ""), kind })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(getApiErrorMessage(body, "Failed to create room"));
      setLoading(null);
      return;
    }

    const body = await response.json();
    router.push(`/permissions?roomId=${body.room.id}`);
  }

  return (
    <div className="grid tileGrid">
      {error && <div className="alert alertFull">{error}</div>}
      <form className="card tile formGrid" onSubmit={(event) => create(event, "podcast")}>
        <span className="pill">Podcast</span>
        <h2>Record with someone else</h2>
        <p className="muted">Create a room, invite guests by email, and record the session.</p>
        <div className="field">
          <label htmlFor="podcastName">Room name</label>
          <input id="podcastName" name="RoomName" placeholder="Founder interview" required />
        </div>
        <button className="btn btnPrimary" disabled={loading !== null}>
          {loading === "podcast" ? "Creating..." : "Create podcast room"}
        </button>
      </form>

      <form className="card tile formGrid" onSubmit={(event) => create(event, "self-record")}>
        <span className="pill">Self recorder</span>
        <h2>Record yourself</h2>
        <p className="muted">Open a solo recording room for camera, mic, and screen capture.</p>
        <div className="field">
          <label htmlFor="soloName">Recording name</label>
          <input id="soloName" name="RoomName" placeholder="Episode draft" required />
        </div>
        <button className="btn btnSuccess" disabled={loading !== null}>
          {loading === "self-record" ? "Creating..." : "Create self recording"}
        </button>
      </form>
    </div>
  );
}
