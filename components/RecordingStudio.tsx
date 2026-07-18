"use client";

import { useState } from "react";
import { InviteParticipant } from "@/components/InviteParticipant";
import { Recorder, type LiveParticipant } from "@/components/Recorder";

type RecordingStudioProps = {
  roomId: string;
  roomKind: "PODCAST" | "SELF_RECORD";
  isOwner: boolean;
  currentUser: { name: string; username: string };
};

export function RecordingStudio({ roomId, roomKind, isOwner, currentUser }: RecordingStudioProps) {
  const [liveParticipants, setLiveParticipants] = useState<LiveParticipant[]>([{
    peerId: "local",
    name: currentUser.name || currentUser.username,
    username: currentUser.username
  }]);

  return (
    <div className="studio">
      <Recorder
        roomId={roomId}
        isOwner={isOwner}
        currentUser={currentUser}
        onParticipantsChange={setLiveParticipants}
      />
      <aside className="card sidePanel">
        <h2>Live participants</h2>
        <p className="muted">Everyone currently connected to this recording room appears here and in the video grid.</p>
        <div className="list">
          {liveParticipants.map((participant) => (
            <span className="pill" key={participant.peerId}>
              {participant.peerId === "local" ? "You" : participant.name || `@${participant.username}`}
            </span>
          ))}
        </div>
        {roomKind === "PODCAST" && isOwner && (
          <>
            <hr style={{ borderColor: "var(--line)", margin: "20px 0" }} />
            <h2>Add participant</h2>
            <InviteParticipant roomId={roomId} />
          </>
        )}
      </aside>
    </div>
  );
}
