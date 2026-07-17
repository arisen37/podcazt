import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { fail, enforceRateLimit } from "@/lib/api";
import { setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SignupSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "signin", limit: 8, windowMs: 60_000 });
  if (limited) return limited;

  const parsed = SignupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid sign-up payload", 422, parsed.error.flatten());

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const user = await prisma.user
    .create({
      data: {
        email: parsed.data.emailId,
        password: passwordHash,
        username: parsed.data.username,
        name: parsed.data.name
      },
      select: { id: true, email: true, username: true, name: true, createdAt: true }
    })
    .catch(() => null);

  if (!user) {
    return fail("Email or username is already in use", 409);
  }

  const response = NextResponse.json({ user });
  await setSessionCookie(response, {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name
  });
  return response;
}
