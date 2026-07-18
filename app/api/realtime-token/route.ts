import { fail, ok } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { createRealtimeToken } from "@/lib/realtime-token";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  return ok({ token: await createRealtimeToken(user) });
}
