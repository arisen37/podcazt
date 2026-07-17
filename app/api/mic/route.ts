import { NextRequest } from "next/server";
import { handleControl } from "@/lib/control-route";

export async function POST(request: NextRequest) {
  return handleControl(request, "mic");
}
