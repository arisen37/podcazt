import express from "express";
import http from "http";
import Redis from "ioredis";
import { WebSocketServer, WebSocket } from "ws";

type SignalMessage = {
  type: "join" | "offer" | "answer" | "ice-candidate" | "leave";
  roomId: string;
  peerId: string;
  targetPeerId?: string;
  payload?: unknown;
};

const port = Number(process.env.SIGNALING_PORT ?? 4000);
const redisUrl = process.env.REDIS_URL;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map<string, Map<string, WebSocket>>();

const publisher = redisUrl ? new Redis(redisUrl) : null;
const subscriber = redisUrl ? new Redis(redisUrl) : null;

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "podcazt-signaling" });
});

function broadcast(message: SignalMessage, excludePeerId?: string) {
  const peers = rooms.get(message.roomId);
  if (!peers) return;

  for (const [peerId, socket] of peers.entries()) {
    if (peerId === excludePeerId) continue;
    if (message.targetPeerId && peerId !== message.targetPeerId) continue;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

async function publish(message: SignalMessage) {
  if (!publisher) {
    broadcast(message, message.type === "join" ? message.peerId : undefined);
    return;
  }
  await publisher.publish(`room:${message.roomId}`, JSON.stringify(message));
}

if (subscriber) {
  subscriber.psubscribe("room:*");
  subscriber.on("pmessage", (_pattern, _channel, raw) => {
    const message = JSON.parse(raw) as SignalMessage;
    broadcast(message, message.type === "join" ? message.peerId : undefined);
  });
}

wss.on("connection", (socket) => {
  let currentRoomId: string | null = null;
  let currentPeerId: string | null = null;

  socket.on("message", async (raw) => {
    const message = JSON.parse(raw.toString()) as SignalMessage;
    if (!message.roomId || !message.peerId || !message.type) return;

    if (message.type === "join") {
      currentRoomId = message.roomId;
      currentPeerId = message.peerId;
      const peers = rooms.get(message.roomId) ?? new Map<string, WebSocket>();
      peers.set(message.peerId, socket);
      rooms.set(message.roomId, peers);
      if (subscriber) await subscriber.subscribe(`room:${message.roomId}`);
    }

    await publish(message);
  });

  socket.on("close", async () => {
    if (!currentRoomId || !currentPeerId) return;
    rooms.get(currentRoomId)?.delete(currentPeerId);
    await publish({ type: "leave", roomId: currentRoomId, peerId: currentPeerId });
  });
});

server.listen(port, () => {
  console.log(`Podcazt signaling server listening on :${port}`);
});
