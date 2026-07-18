import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { createRoomForUser } from "@/lib/rooms";
import { CreateRoomSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "self-room", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const parsed = CreateRoomSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return fail("Invalid room payload", 422, parsed.error.flatten());

  try {
    const result = await createRoomForUser({
      user,
      name: parsed.data.RoomName,
      kind: "self-record"
    });
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to create room", 500);
  }
}
