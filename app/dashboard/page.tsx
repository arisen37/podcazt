import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const videos = await prisma.video.findMany({
    where: { room: { roomOwnerId: user.id }, completedAt: { not: null } },
    include: {
      frames: { orderBy: { createdAt: "desc" }, take: 1 },
      room: { select: { name: true, kind: true } }
    },
    orderBy: { completedAt: "desc" },
    take: 24
  });

  return (
    <main className="dashboardPage">
      <div className="shell dashboardShell">
        <header className="dashboardHeader">
          <div>
            <p className="dashboardKicker">Your studio</p>
            <h1>Welcome back, {user.name.split(" ")[0]}.</h1>
          </div>
          <div className="dashboardActions">
            <Link className="btn dashboardCreate" href="/create">New recording</Link>
          </div>
        </header>

        <section className="librarySection">
          <div className="libraryHeading">
            <div>
              <h2>Recordings</h2>
              <p>Completed sessions and their captured preview frames.</p>
            </div>
            <span>{videos.length} {videos.length === 1 ? "video" : "videos"}</span>
          </div>

          {videos.length === 0 ? (
            <div className="dashboardEmpty">
              <div className="emptyPlay">▶</div>
              <h2>No footage yet</h2>
              <p>Only completed recordings with video content appear here.</p>
              <Link className="btn dashboardCreate" href="/create">Create your first recording</Link>
            </div>
          ) : (
            <div className="videoLibraryGrid">
              {videos.map((video) => (
                <a className="libraryCard" href={video.link as string} target="_blank" rel="noreferrer" key={video.id}>
                  <div className="libraryPreview">
                    {video.frames[0]?.link ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={video.frames[0].link} alt={`Preview for ${video.room.name}`} />
                    ) : (
                      <div className="previewFallback"><span>▶</span></div>
                    )}
                    <span className="previewPlay">▶</span>
                  </div>
                  <div className="libraryMeta">
                    <h3>{video.room.name}</h3>
                    <div>
                      <span>
                        {video.room.kind === "PODCAST" ? "Podcast" : "Solo recording"}
                        {video.byteSize ? ` · ${formatBytes(video.byteSize)}` : ""}
                      </span>
                      <time dateTime={(video.completedAt ?? video.createdAt).toISOString()}>
                        {(video.completedAt ?? video.createdAt).toLocaleDateString()}
                      </time>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function formatBytes(value: bigint) {
  const bytes = Number(value);
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
