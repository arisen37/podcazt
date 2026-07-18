import { fail, ok } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const invites = await prisma.invite.findMany({
    where: { invitedEmail: user.email, status: "PENDING", room: { closedAt: null } },
    include: {
      room: true,
      inviter: { select: { id: true, name: true, username: true, email: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  return ok({ invites });
}
