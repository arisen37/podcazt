import { fail, ok } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const videos = await prisma.video.findMany({
    where: { room: { roomOwnerId: user.id }, completedAt: { not: null } },
    select: {
      id: true,
      link: true,
      mimeType: true,
      byteSize: true,
      sha256: true,
      createdAt: true,
      completedAt: true,
      room: { select: { id: true, name: true, kind: true } },
      frames: { orderBy: { createdAt: "desc" }, take: 1 }
    },
    orderBy: { completedAt: "desc" }
  });

  return ok({
    videos: videos.map((video) => ({
      ...video,
      byteSize: video.byteSize?.toString() ?? null
    }))
  });
}
