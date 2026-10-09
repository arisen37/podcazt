import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ ok: true, service: "podcazt-web" }, {
    headers: { "Cache-Control": "no-store" }
  });
}
