import { getOptionalEnv } from "@/lib/env";
import { getRedis } from "@/lib/redis";

export type InviteRealtimeEvent = {
  type: "invite";
  invite: {
    id: string;
    roomId: string;
    roomName: string;
    inviterName: string;
    createdAt: string;
  };
};

export async function publishInviteEvent(email: string, event: InviteRealtimeEvent) {
  const redis = getRedis();
  if (redis) {
    await redis.publish(`notifications:${email.toLowerCase()}`, JSON.stringify(event));
    return true;
  }

  const signalingUrl = getOptionalEnv("SIGNALING_INTERNAL_URL");
  const secret = getOptionalEnv("SIGNALING_INTERNAL_SECRET");
  if (!signalingUrl || !secret) return false;

  const response = await fetch(`${signalingUrl.replace(/\/$/, "")}/events/invite`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ email, event })
  });

  return response.ok;
}
