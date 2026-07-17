import { fail, ok } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const videos = await prisma.video.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" }
  });

  return ok({ videos });
}
