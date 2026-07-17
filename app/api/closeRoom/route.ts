import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "close-room", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => ({}));
  if (!body.roomId || typeof body.roomId !== "string") return fail("roomId is required", 422);

  const room = await prisma.room.findUnique({ where: { id: body.roomId } });

  if (!room) return fail("Room not found", 404);
  if (room.roomOwnerId !== user.id) return fail("Only the room owner can close the room", 403);

  await prisma.room.update({
    where: { id: room.id },
    data: { closedAt: new Date() }
  });
  return ok({ ok: true });
}
