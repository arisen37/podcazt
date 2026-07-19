import { NextRequest } from "next/server";
import { enforceRateLimit, fail, ok } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { getOptionalEnv } from "@/lib/env";

function sanitizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const rawUrls = Array.isArray(candidate.urls) ? candidate.urls : [candidate.urls];
    const urls = rawUrls.filter((url): url is string =>
      typeof url === "string" && /^(?:stun|stuns|turn|turns):[^\s]+$/i.test(url)
    );
    if (urls.length === 0) return [];

    const server: RTCIceServer = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof candidate.username === "string") server.username = candidate.username;
    if (typeof candidate.credential === "string") server.credential = candidate.credential;
    return [server];
  });
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const limited = await enforceRateLimit(request, { key: "turn-credentials", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const appName = getOptionalEnv("METERED_TURN_APP_NAME");
  const apiKey = getOptionalEnv("METERED_TURN_API_KEY");
  if (!appName || !/^[a-z0-9-]+$/i.test(appName) || !apiKey) {
    return fail("TURN service is not configured", 503);
  }

  const endpoint = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
  endpoint.searchParams.set("apiKey", apiKey);

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return fail("TURN provider rejected the credential request", 502);

    const iceServers = sanitizeIceServers(await response.json());
    if (!iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => /^turns?:/i.test(url));
    })) {
      return fail("TURN provider returned no relay servers", 502);
    }

    return ok({ iceServers }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return fail("Could not reach the TURN provider", 502);
  }
}
