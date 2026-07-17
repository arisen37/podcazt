"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getApiErrorMessage } from "@/lib/client-error";

export function AcceptInviteButton({ inviteId }: { inviteId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function accept() {
    setLoading(true);
    setError("");
    const response = await fetch(`/api/invites/${inviteId}/accept`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(getApiErrorMessage(body, "Failed to accept invite"));
      setLoading(false);
      return;
    }
    router.push(`/permissions?roomId=${body.roomId}`);
  }

  return (
    <div className="formGrid">
      <button className="btn btnPrimary" disabled={loading} onClick={accept}>
        {loading ? "Joining..." : "Accept and join"}
      </button>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
