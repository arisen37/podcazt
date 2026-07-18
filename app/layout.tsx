import type { Metadata } from "next";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { NotificationBell, type NotificationInvite } from "@/components/NotificationBell";
import { ProfileMenu } from "@/components/ProfileMenu";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podcazt",
  description: "Record podcasts and solo episodes from the browser."
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  let notifications: NotificationInvite[] = [];

  if (user) {
    const invites = await prisma.invite.findMany({
      where: { invitedEmail: user.email, status: "PENDING", room: { closedAt: null } },
      select: {
        id: true,
        roomId: true,
        createdAt: true,
        room: { select: { name: true } },
        inviter: { select: { name: true, username: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 30
    });
    notifications = invites.map((invite) => ({
      id: invite.id,
      roomId: invite.roomId,
      roomName: invite.room.name,
      inviterName: invite.inviter.name || invite.inviter.username,
      createdAt: invite.createdAt.toISOString()
    }));
  }

  return (
    <html lang="en">
      <body className={user ? "authenticatedBody" : undefined}>
        <div className={`navWrap ${user ? "authenticatedNavWrap" : ""}`}>
          <div className="shell">
            <nav className="nav">
              <Link className="brand" href="/">
                Podcazt<span className="brandDot">.</span>
              </Link>
              {user ? (
                <div className="authenticatedNavActions">
                  <Link className="navLibraryLink" href="/dashboard">Library</Link>
                  <NotificationBell initialInvites={notifications} />
                  <Link className="btn btnPrimary navCreateButton" href="/create">New recording</Link>
                  <ProfileMenu name={user.name} username={user.username} email={user.email} />
                </div>
              ) : (
                <div className="btnRow">
                  <Link className="btn btnPrimary" href="/signin">Try for free</Link>
                </div>
              )}
            </nav>
          </div>
        </div>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
