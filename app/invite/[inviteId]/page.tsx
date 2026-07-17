import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AcceptInviteButton } from "@/components/AcceptInviteButton";

export default async function InvitePage({ params }: { params: Promise<{ inviteId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const { inviteId } = await params;
  const invite = await prisma.invite.findUnique({
    where: { id: inviteId },
    include: {
      room: true,
      inviter: { select: { name: true, username: true, email: true } }
    }
  });

  if (!invite) {
    return (
      <main className="shell hero">
        <section className="card formCard">
          <h1>Invite not found</h1>
          <Link className="btn" href="/dashboard">Back to dashboard</Link>
        </section>
      </main>
    );
  }

  const belongsToUser = invite.invitedEmail === user.email;

  return (
    <main className="shell hero">
      <section>
        <p className="pill">Podcast invite</p>
        <h1>{invite.room.name}</h1>
        <p className="muted">Invited by {invite.inviter.name || invite.inviter.username}.</p>
      </section>
      <section className="card formCard">
        {!belongsToUser ? (
          <>
            <h2>Email mismatch</h2>
            <p className="muted">This invite was sent to {invite.invitedEmail}. You are logged in as {user.email}.</p>
          </>
        ) : invite.status !== "PENDING" ? (
          <>
            <h2>Invite already used</h2>
            <Link className="btn btnPrimary" href={`/permissions?roomId=${invite.roomId}`}>Open room</Link>
          </>
        ) : (
          <>
            <h2>Join this recording room?</h2>
            <p className="muted">Accepting adds the room to your account and opens the device permission step.</p>
            <AcceptInviteButton inviteId={invite.id} />
          </>
        )}
      </section>
    </main>
  );
}
