import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

export async function enforceRateLimit(
  request: NextRequest,
  options: { key: string; limit: number; windowMs: number }
) {
  const result = await rateLimit(request, options);
  if (!result.ok) {
    return fail("Too many requests. Try again shortly.", 429);
  }
  return null;
}
