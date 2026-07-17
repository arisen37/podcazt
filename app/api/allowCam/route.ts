import { fail, ok } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);
  return ok({ allowed: true, permission: "camera" });
}
