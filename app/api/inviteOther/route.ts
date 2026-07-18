import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { sendInviteEmail } from "@/lib/email";
import { assertRoomAccess } from "@/lib/rooms";
import { prisma } from "@/lib/prisma";
import { publishInviteEvent } from "@/lib/realtime-events";
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
  if (room.roomOwnerId !== user.id) {
    return fail("Only the room owner can invite participants", 403);
  }
  if (room.closedAt) return fail("This room is already closed", 409);
  if (parsed.data.emailId === user.email) return fail("You are already in this room", 409);

  const invitedUser = await prisma.user.findUnique({
    where: { email: parsed.data.emailId },
    select: { id: true }
  });

  const existingInvite = await prisma.invite.findUnique({
    where: { roomId_invitedEmail: { roomId: room.id, invitedEmail: parsed.data.emailId } }
  });
  if (existingInvite?.status === "PENDING") return fail("This participant already has a pending invite", 409);
  if (existingInvite?.status === "ACCEPTED") return fail("This participant is already a room member", 409);

  const invite = existingInvite
    ? await prisma.invite.update({
        where: { id: existingInvite.id },
        data: {
          inviterId: user.id,
          invitedId: invitedUser?.id ?? null,
          status: "PENDING",
          createdAt: new Date(),
          respondedAt: null
        }
      })
    : await prisma.invite.create({
        data: {
          inviterId: user.id,
          invitedId: invitedUser?.id ?? null,
          invitedEmail: parsed.data.emailId,
          roomId: room.id,
          status: "PENDING"
        }
      });

  const realtimeDelivered = await publishInviteEvent(parsed.data.emailId, {
    type: "invite",
    invite: {
      id: invite.id,
      roomId: room.id,
      roomName: room.name,
      inviterName: user.name || user.username,
      createdAt: invite.createdAt.toISOString()
    }
  }).catch((error) => {
    console.error("Realtime invite delivery failed", error);
    return false;
  });

  const emailResult = await sendInviteEmail({
    to: parsed.data.emailId,
    inviterName: user.name || user.username,
    roomName: room.name,
    inviteId: invite.id,
    requestOrigin: request.nextUrl.origin
  });

  return ok({ invite, email: emailResult, realtimeDelivered });
}
