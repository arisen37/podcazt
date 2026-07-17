import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { assertRoomAccess } from "@/lib/rooms";

export async function handleControl(request: NextRequest, control: string) {
  const limited = await enforceRateLimit(request, { key: `control-${control}`, limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const body = await request.json().catch(() => ({}));
  if (!body.roomId || typeof body.roomId !== "string") {
    return fail("roomId is required", 422);
  }

  try {
    await assertRoomAccess(body.roomId, user.id);
    return ok({
      ok: true,
      control,
      roomId: body.roomId,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Control failed", 403);
  }
}
