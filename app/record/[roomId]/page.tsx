import { redirect } from "next/navigation";
import { InviteParticipant } from "@/components/InviteParticipant";
import { Recorder } from "@/components/Recorder";
import { getCurrentUser } from "@/lib/auth";
import { assertRoomAccess, getRoomRoster } from "@/lib/rooms";

export default async function RecordPage({ params }: { params: Promise<{ roomId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const { roomId } = await params;
  let room;
  try {
    room = await assertRoomAccess(roomId, user.id);
  } catch {
    redirect("/dashboard");
  }
  const roster = await getRoomRoster(room.id);

  return (
    <main className="shell page">
      <div className="topbar">
        <div>
          <p className="pill">{room.kind === "PODCAST" ? "Podcast room" : "Self recorder"}</p>
          <h1 className="pageTitle">{room.name}</h1>
        </div>
      </div>
      <div className="studio">
        <Recorder
          roomId={room.id}
          isOwner={room.roomOwnerId === user.id}
          currentUser={{ name: user.name, username: user.username }}
        />
        <aside className="card sidePanel">
          <h2>Room</h2>
          <p className="muted">Use the controls below the preview to record, mute, toggle camera, raise hand, share screen, or leave.</p>
          <div className="list">
            {roster.map((member) => (
              <span className="pill" key={member.id}>
                {member.id === user.id ? "You" : member.name || `@${member.username}`}
              </span>
            ))}
          </div>
          {room.kind === "PODCAST" && room.roomOwnerId === user.id && (
            <>
              <hr style={{ borderColor: "var(--line)", margin: "20px 0" }} />
              <h2>Add participant</h2>
              <InviteParticipant roomId={room.id} />
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
