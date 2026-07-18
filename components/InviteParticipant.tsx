"use client";

import { FormEvent, useState } from "react";
import { getApiErrorMessage } from "@/lib/client-error";

export function InviteParticipant({ roomId }: { roomId: string }) {
  const [message, setMessage] = useState("");
  const [succeeded, setSucceeded] = useState(false);
  const [loading, setLoading] = useState(false);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setSucceeded(false);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/inviteOther", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, emailId: String(form.get("emailId")) })
    });
    const body = await response.json().catch(() => ({}));
    setLoading(false);
    if (!response.ok) {
      setMessage(getApiErrorMessage(body, "Invite failed"));
      return;
    }
    setSucceeded(true);
    const deliveries = [body.realtimeDelivered && "realtime notification", body.email?.sent && "email"].filter(Boolean);
    setMessage(deliveries.length
      ? `Invite sent by ${deliveries.join(" and ")}.`
      : `Invite created. ${body.email?.reason || "Realtime and email delivery are not configured."}`
    );
    event.currentTarget.reset();
  }

  return (
    <form className="formGrid" onSubmit={invite}>
      <div className="field">
        <label htmlFor="emailId">Participant email</label>
        <input id="emailId" name="emailId" type="email" required placeholder="guest@example.com" />
      </div>
      <button className="btn btnPrimary" disabled={loading}>
        {loading ? "Sending..." : "Invite participant"}
      </button>
      {message && <div className={`alert ${succeeded ? "ok" : ""}`}>{message}</div>}
    </form>
  );
}
