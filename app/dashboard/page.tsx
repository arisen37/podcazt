import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [videos, invites] = await Promise.all([
    prisma.video.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20
    }),
    prisma.invite.findMany({
      where: { invitedEmail: user.email, status: "PENDING" },
      include: {
        room: true,
        inviter: { select: { name: true, username: true, email: true } }
      },
      orderBy: { createdAt: "desc" }
    })
  ]);

  return (
    <main className="shell page">
      <div className="topbar">
        <div>
          <p className="pill">Signed in as @{user.username}</p>
          <h1 className="pageTitle">Dashboard</h1>
        </div>
        <Link className="btn btnPrimary" href="/create">+ Create new</Link>
      </div>

      <div className="grid dashboardGrid">
        <section className="card">
          <div className="tile">
            <h2>Past recorded videos</h2>
            <p className="muted">Recordings appear here after all browser chunks are verified and uploaded.</p>
          </div>
          {videos.length === 0 ? (
            <div className="videoCard muted">No recordings yet.</div>
          ) : (
            videos.map((video) => (
              <div className="videoCard" key={video.id}>
                <div>
                  <h3>{video.name}</h3>
                  <p className="muted">{video.createdAt.toLocaleString()}</p>
                </div>
                {video.link ? (
                  <a className="btn" href={video.link} target="_blank" rel="noreferrer">Open</a>
                ) : (
                  <span className="pill">Pending upload</span>
                )}
              </div>
            ))
          )}
        </section>

        <section className="card">
          <div className="tile">
            <h2>Invites</h2>
            <p className="muted">Podcast room invitations sent to your email.</p>
          </div>
          {invites.length === 0 ? (
            <div className="videoCard muted">No incoming invites.</div>
          ) : (
            invites.map((invite) => (
              <div className="videoCard" key={invite.id}>
                <div>
                  <h3>{invite.room.name}</h3>
                  <p className="muted">From {invite.inviter.name || invite.inviter.username}</p>
                </div>
                <Link className="btn btnSuccess" href={`/invite/${invite.id}`}>Join</Link>
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
