import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ inviteId: string }> }
) {
  const limited = await enforceRateLimit(request, { key: "accept-invite", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const { inviteId } = await context.params;
  const invite = await prisma.invite.findUnique({
    where: { id: inviteId }
  });

  if (!invite) return fail("Invite not found", 404);
  if (invite.invitedEmail !== user.email) return fail("This invite belongs to another email address", 403);
  if (invite.status !== "PENDING") return fail("Invite is no longer pending", 400);

  await prisma.$transaction([
    prisma.room.update({
      where: { id: invite.roomId },
      data: {
        members: {
          connect: { id: user.id }
        }
      }
    }),
    prisma.invite.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED", invitedId: user.id }
    })
  ]);

  return ok({ roomId: invite.roomId });
}
