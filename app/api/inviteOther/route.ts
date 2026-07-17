import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { sendInviteEmail } from "@/lib/email";
import { assertRoomAccess } from "@/lib/rooms";
import { prisma } from "@/lib/prisma";
import { InviteSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "invite-other", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid invite payload", 422, parsed.error.flatten());

  let room;
  try {
    room = await assertRoomAccess(parsed.data.roomId, user.id);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Room access denied", 403);
  }

  if (room.kind !== "PODCAST") {
    return fail("Inviting participants is only available for podcast rooms", 400);
  }

  const invitedUser = await prisma.user.findUnique({
    where: { email: parsed.data.emailId },
    select: { id: true }
  });

  const invite = await prisma.invite.create({
    data: {
      inviterId: user.id,
      invitedId: invitedUser?.id ?? null,
      invitedEmail: parsed.data.emailId,
      roomId: room.id,
      status: "PENDING"
    }
  });

  const emailResult = await sendInviteEmail({
    to: parsed.data.emailId,
    inviterName: user.name || user.username,
    roomName: room.name,
    inviteId: invite.id
  });

  return ok({ invite, email: emailResult });
}
