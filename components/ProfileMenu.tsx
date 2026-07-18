"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProfileMenu({ name, username, email }: { name: string; username: string; email: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    const response = await fetch("/api/logout", { method: "POST" }).catch(() => null);
    if (!response?.ok) {
      setLoading(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="profileMenu">
      <button className="navAvatar" type="button" aria-label="Open profile menu" aria-haspopup="menu">
        {(name || username).slice(0, 1).toUpperCase()}
      </button>
      <section className="profilePopover" aria-label="Profile menu">
        <div className="profileIdentity">
          <strong>{name}</strong>
          <span>@{username}</span>
          <small>{email}</small>
        </div>
        <button className="profileLogout" type="button" role="menuitem" onClick={() => void logout()} disabled={loading}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
          </svg>
          {loading ? "Logging out…" : "Log out"}
        </button>
      </section>
    </div>
  );
}
