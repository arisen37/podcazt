import { jwtVerify, type JWTPayload } from "jose";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "podcazt_session";
const SESSION_ISSUER = "podcazt";
const SESSION_AUDIENCE = "podcazt-web";
const PUBLIC_PAGES = new Set(["/", "/signin", "/login"]);
const encoder = new TextEncoder();

function isSessionPayload(payload: JWTPayload) {
  return (
    payload.typ === "session" &&
    typeof payload.sub === "string" &&
    typeof payload.email === "string" &&
    typeof payload.username === "string" &&
    typeof payload.name === "string"
  );
}

async function hasValidSession(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const currentSecret = process.env.SESSION_SECRET;
  if (!token || !currentSecret) return false;

  const secrets = [currentSecret, process.env.SESSION_SECRET_PREVIOUS].filter(
    (secret): secret is string => Boolean(secret)
  );

  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(secret), {
        algorithms: ["HS256"],
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
        clockTolerance: 5
      });
      if (isSessionPayload(payload)) return true;
    } catch {
      // Try the previous signing key during a session-secret rotation.
    }
  }

  return false;
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/signin" && (await hasValidSession(request))) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (PUBLIC_PAGES.has(request.nextUrl.pathname)) return NextResponse.next();
  if (await hasValidSession(request)) return NextResponse.next();

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

export const config = {
  matcher: ["/((?!api(?:/|$)|_next(?:/|$)|.*\\..*).*)"]
};
