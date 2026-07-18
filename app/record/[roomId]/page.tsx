import { redirect } from "next/navigation";
import { RecordingStudio } from "@/components/RecordingStudio";
import { getCurrentUser } from "@/lib/auth";
import { assertRoomAccess } from "@/lib/rooms";

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
  return (
    <main className="shell page">
      <div className="topbar">
        <div>
          <p className="pill">{room.kind === "PODCAST" ? "Podcast room" : "Self recorder"}</p>
          <h1 className="pageTitle">{room.name}</h1>
        </div>
      </div>
      <RecordingStudio
        roomId={room.id}
        roomKind={room.kind}
        isOwner={room.roomOwnerId === user.id}
        currentUser={{ name: user.name, username: user.username }}
      />
    </main>
  );
}
