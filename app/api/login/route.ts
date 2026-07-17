import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { fail, enforceRateLimit } from "@/lib/api";
import { setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LoginSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "login", limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const parsed = LoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid login payload", 422, parsed.error.flatten());

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.emailId }
  });

  if (!user) return fail("Invalid email or password", 401);

  const valid = await bcrypt.compare(parsed.data.password, user.password);
  if (!valid) return fail("Invalid email or password", 401);

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      createdAt: user.createdAt
    }
  });
  await setSessionCookie(response, {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name
  });
  return response;
}
