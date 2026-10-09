import { createHmac } from "node:crypto";

export function createTurnCredentials(userId: string, now = Date.now()) {
  const host = process.env.TURN_HOST;
  const secret = process.env.TURN_SHARED_SECRET;
  if (!host || !secret) return null;
  if (!/^[a-z0-9.-]+$/i.test(host) || secret.length < 32) {
    throw new Error("Invalid self-hosted TURN configuration");
  }
  // Long enough for a podcast session; refreshed on the next studio visit.
  const ttl = 12 * 60 * 60;
  const expiresAt = Math.floor(now / 1000) + ttl;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return {
    expiresAt,
    iceServers: [
      { urls: `stun:${host}:3478` },
      {
        urls: [
          `turn:${host}:3478?transport=udp`,
          `turn:${host}:3478?transport=tcp`,
          `turns:${host}:5349?transport=tcp`
        ],
        username,
        credential
      }
    ]
  };
}
