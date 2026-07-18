import { cache } from "react";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import type { SessionUser } from "@/lib/types";
import { getEnv, getOptionalEnv } from "@/lib/env";

const SESSION_COOKIE = "podcazt_session";
const SESSION_ISSUER = "podcazt";
const SESSION_AUDIENCE = "podcazt-web";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();

function signingSecret() {
  const value = getEnv("SESSION_SECRET");
  if (process.env.NODE_ENV === "production" && value.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
  return encoder.encode(value);
}

function verificationSecrets() {
  const previous = getOptionalEnv("SESSION_SECRET_PREVIOUS");
  return [signingSecret(), ...(previous ? [encoder.encode(previous)] : [])];
}

function sessionUserFromPayload(payload: JWTPayload): SessionUser | null {
  if (
    payload.typ !== "session" ||
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
}

export async function createSessionToken(user: SessionUser) {
  return new SignJWT({
    typ: "session",
    email: user.email,
    username: user.username,
    name: user.name
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(signingSecret());
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  for (const secret of verificationSecrets()) {
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
        clockTolerance: 5
      });
      return sessionUserFromPayload(payload);
    } catch {
      // Try the previous key during a zero-downtime secret rotation.
    }
  }
  return null;
}

export const getCurrentUser = cache(async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
});

export async function setSessionCookie(response: NextResponse, user: SessionUser) {
  response.cookies.set(SESSION_COOKIE, await createSessionToken(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    priority: "high"
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
    priority: "high"
  });
}
