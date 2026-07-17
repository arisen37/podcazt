import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertRoomAccess } from "@/lib/rooms";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "control-leaveCall", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => ({}));
  if (!body.roomId || typeof body.roomId !== "string") {
    return fail("roomId is required", 422);
  }

  try {
    const room = await assertRoomAccess(body.roomId, user.id);
    const shouldCloseRoom = room.roomOwnerId === user.id && !room.closedAt;

    if (shouldCloseRoom) {
      await prisma.room.update({
        where: { id: room.id },
        data: { closedAt: new Date() }
      });
    }

    return ok({
      ok: true,
      control: "leaveCall",
      roomId: body.roomId,
      closedRoom: shouldCloseRoom
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Leave call failed", 403);
  }
}
