import { jwtVerify, SignJWT } from "jose";
import { getEnv } from "@/lib/env";
import type { SessionUser } from "@/lib/types";

const encoder = new TextEncoder();
const audience = "podcazt-realtime";

function realtimeSecret() {
  return encoder.encode(getEnv("SESSION_SECRET"));
}

export async function createRealtimeToken(user: SessionUser) {
  return new SignJWT({
    scope: "realtime",
    email: user.email,
    username: user.username,
    name: user.name
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(realtimeSecret());
}

export async function verifyRealtimeToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, realtimeSecret(), { audience });
    if (
      payload.scope !== "realtime" ||
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.username !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }

    return {
      id: payload.sub,
      email: payload.email,
      username: payload.username,
      name: payload.name
    };
  } catch {
    return null;
  }
}
