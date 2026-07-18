"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getRealtimeToken, getSignalingUrl } from "@/lib/realtime-client";

export type NotificationInvite = {
  id: string;
  roomId: string;
  roomName: string;
  inviterName: string;
  createdAt: string;
};

export function NotificationBell({ initialInvites }: { initialInvites: NotificationInvite[] }) {
  const centerRef = useRef<HTMLDivElement>(null);
  const [invites, setInvites] = useState(initialInvites);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;

    void getRealtimeToken()
      .then((token) => {
        if (!active) return;
        socket = new WebSocket(getSignalingUrl(token));
        socket.onmessage = (message) => {
          const event = JSON.parse(String(message.data)) as { type?: string; invite?: NotificationInvite };
          if (event.type !== "invite" || !event.invite) return;
          setInvites((current) => current.some((invite) => invite.id === event.invite?.id)
            ? current
            : [event.invite as NotificationInvite, ...current]
          );
        };
      })
      .catch(() => undefined);

    const removeAcceptedInvite = (event: Event) => {
      const inviteId = (event as CustomEvent<{ inviteId?: string }>).detail?.inviteId;
      if (inviteId) setInvites((current) => current.filter((invite) => invite.id !== inviteId));
    };
    window.addEventListener("podcazt:invite-accepted", removeAcceptedInvite);

    return () => {
      active = false;
      socket?.close(1000, "Navigation closed");
      window.removeEventListener("podcazt:invite-accepted", removeAcceptedInvite);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!centerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={centerRef}
      className="notificationCenter"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className="notificationBell"
        type="button"
        aria-label={`${invites.length} pending invitations`}
        aria-expanded={open}
        aria-controls="notification-popover"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {invites.length > 0 && <span className="notificationCount">{invites.length > 99 ? "99+" : invites.length}</span>}
      </button>

      {open && (
        <section id="notification-popover" className="notificationPopover" aria-label="Active notifications">
          <div className="notificationHeader">
            <strong>Notifications</strong>
            <span>{invites.length} active</span>
          </div>
          {invites.length === 0 ? (
            <p className="notificationEmpty">You’re all caught up.</p>
          ) : invites.map((invite) => (
            <Link className="notificationItem" href={`/invite/${invite.id}`} key={invite.id} onClick={() => setOpen(false)}>
              <span className="notificationAvatar">{invite.inviterName.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{invite.inviterName}</strong> invited you to <em>{invite.roomName}</em>
                <small>{new Date(invite.createdAt).toLocaleString()}</small>
              </span>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
