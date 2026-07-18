import express from "express";
import http from "http";
import Redis from "ioredis";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { prisma } from "../lib/prisma";
import { verifyRealtimeToken } from "../lib/realtime-token";
import type { InviteRealtimeEvent } from "../lib/realtime-events";
import type { SessionUser } from "../lib/types";

type ClientMessage = {
  type: "join" | "offer" | "answer" | "ice-candidate" | "leave" | "end-room";
  roomId?: string;
  targetPeerId?: string;
  payload?: unknown;
};

type SignalingEvent =
  | {
      type: "peer-joined";
      roomId: string;
      peerId: string;
      user: ReturnType<typeof peerSummary>["user"];
    }
  | {
      type: "peer-left";
      roomId: string;
      peerId: string;
    }
  | {
      type: "signal";
      signalType: "offer" | "answer" | "ice-candidate";
      roomId: string;
      targetPeerId: string;
      peerId: string;
      user: ReturnType<typeof peerSummary>["user"];
      payload?: unknown;
    }
  | {
      type: "room-ended";
      roomId: string;
    };

type Peer = {
  peerId: string;
  socket: WebSocket;
  user: SessionUser;
  alive: boolean;
};

const port = Number(process.env.SIGNALING_PORT ?? 4000);
const redisUrl = process.env.REDIS_URL;
const app = express();
app.use(express.json({ limit: "32kb" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map<string, Map<string, Peer>>();
const notificationSockets = new Map<string, Set<WebSocket>>();
const authenticatedUsers = new WeakMap<WebSocket, SessionUser>();
const publisher = redisUrl ? new Redis(redisUrl) : null;
const subscriber = redisUrl ? new Redis(redisUrl) : null;

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "podcazt-signaling" });
});

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function pushNotification(email: string, event: InviteRealtimeEvent) {
  for (const socket of notificationSockets.get(email.toLowerCase()) ?? []) {
    send(socket, event);
  }
}

function deliverSignalingEvent(event: SignalingEvent) {
  const localPeers = rooms.get(event.roomId);
  if (!localPeers) return;

  if (event.type === "peer-joined") {
    for (const peer of localPeers.values()) {
      if (peer.peerId !== event.peerId) {
        send(peer.socket, {
          type: "peer-joined",
          roomId: event.roomId,
          peerId: event.peerId,
          user: event.user
        });
      }
    }
    return;
  }

  if (event.type === "peer-left") {
    for (const peer of localPeers.values()) {
      if (peer.peerId !== event.peerId) {
        send(peer.socket, { type: "peer-left", roomId: event.roomId, peerId: event.peerId });
      }
    }
    return;
  }

  if (event.type === "signal") {
    const target = localPeers.get(event.targetPeerId);
    if (!target) return;
    send(target.socket, {
      type: event.signalType,
      roomId: event.roomId,
      peerId: event.peerId,
      user: event.user,
      payload: event.payload
    });
    return;
  }

  for (const peer of Array.from(localPeers.values())) {
    send(peer.socket, { type: "room-ended", roomId: event.roomId });
    peer.socket.close(1000, "Room ended");
  }
}

async function publishSignalingEvent(event: SignalingEvent) {
  if (!publisher) {
    deliverSignalingEvent(event);
    return;
  }

  try {
    await publisher.publish(`signaling:${event.roomId}`, JSON.stringify(event));
  } catch (error) {
    console.error("Unable to publish signaling event", error);
    deliverSignalingEvent(event);
  }
}

app.post("/events/invite", (request, response) => {
  const secret = process.env.SIGNALING_INTERNAL_SECRET;
  if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const email = typeof request.body?.email === "string" ? request.body.email.toLowerCase() : "";
  const event = request.body?.event as InviteRealtimeEvent | undefined;
  if (!email || event?.type !== "invite" || !event.invite?.id) {
    response.status(422).json({ error: "Invalid invite event" });
    return;
  }

  pushNotification(email, event);
  response.json({ delivered: true });
});

if (subscriber) {
  void subscriber.psubscribe("notifications:*", "signaling:*");
  subscriber.on("pmessage", (_pattern, channel, raw) => {
    try {
      if (channel.startsWith("notifications:")) {
        const email = channel.slice("notifications:".length).toLowerCase();
        pushNotification(email, JSON.parse(raw) as InviteRealtimeEvent);
        return;
      }

      if (channel.startsWith("signaling:")) {
        deliverSignalingEvent(JSON.parse(raw) as SignalingEvent);
      }
    } catch (error) {
      console.error("Invalid realtime event", error);
    }
  });
}

function peerSummary(peer: Peer) {
  return {
    peerId: peer.peerId,
    user: { id: peer.user.id, name: peer.user.name, username: peer.user.username }
  };
}

async function routeSignal(roomId: string, source: Peer, message: ClientMessage) {
  if (!message.targetPeerId) return;
  if (!["offer", "answer", "ice-candidate"].includes(message.type)) return;
  await publishSignalingEvent({
    type: "signal",
    signalType: message.type as "offer" | "answer" | "ice-candidate",
    roomId,
    targetPeerId: message.targetPeerId,
    peerId: source.peerId,
    user: peerSummary(source).user,
    payload: message.payload
  });
}

async function joinRoom(peer: Peer, roomId: string) {
  const room = await prisma.room.findFirst({
    where: {
      id: roomId,
      closedAt: null,
      OR: [{ roomOwnerId: peer.user.id }, { members: { some: { userId: peer.user.id } } }]
    },
    select: { id: true, roomOwnerId: true }
  });

  if (!room) {
    send(peer.socket, { type: "error", message: "Room is closed or access was denied" });
    return null;
  }

  const peers = rooms.get(roomId) ?? new Map<string, Peer>();
  send(peer.socket, {
    type: "peers",
    roomId,
    peers: Array.from(peers.values()).map(peerSummary),
    ownerId: room.roomOwnerId
  });
  peers.set(peer.peerId, peer);
  rooms.set(roomId, peers);

  await publishSignalingEvent({ type: "peer-joined", roomId, ...peerSummary(peer) });

  return room;
}

server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    const user = token ? await verifyRealtimeToken(token) : null;
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      authenticatedUsers.set(websocket, user);
      wss.emit("connection", websocket, request);
    });
  } catch {
    socket.destroy();
  }
});

wss.on("connection", (socket: WebSocket) => {
  const authenticatedUser = authenticatedUsers.get(socket);
  if (!authenticatedUser) {
    socket.close(1008, "Unauthorized");
    return;
  }
  const peer: Peer = {
    peerId: crypto.randomUUID(),
    socket,
    user: authenticatedUser,
    alive: true
  };
  let currentRoomId: string | null = null;
  let currentIsOwner = false;
  const email = authenticatedUser.email.toLowerCase();
  const userSockets = notificationSockets.get(email) ?? new Set<WebSocket>();
  userSockets.add(socket);
  notificationSockets.set(email, userSockets);
  send(socket, { type: "ready", peerId: peer.peerId });

  socket.on("pong", () => {
    peer.alive = true;
  });

  socket.on("message", async (raw: RawData) => {
    try {
      if (raw.toString().length > 1_000_000) return;
      const message = JSON.parse(raw.toString()) as ClientMessage;

      if (message.type === "join" && typeof message.roomId === "string" && !currentRoomId) {
        const room = await joinRoom(peer, message.roomId);
        currentRoomId = room?.id ?? null;
        currentIsOwner = room?.roomOwnerId === authenticatedUser.id;
        return;
      }

      if (!currentRoomId || message.roomId !== currentRoomId) return;
      if (["offer", "answer", "ice-candidate"].includes(message.type)) {
        await routeSignal(currentRoomId, peer, message);
      }
      if (message.type === "end-room" && currentIsOwner) {
        await publishSignalingEvent({ type: "room-ended", roomId: currentRoomId });
        return;
      }
      if (message.type === "leave") socket.close(1000, "Left room");
    } catch (error) {
      console.error("Invalid signaling message", error);
    }
  });

  socket.on("close", () => {
    userSockets.delete(socket);
    if (userSockets.size === 0) notificationSockets.delete(email);
    if (!currentRoomId) return;

    const peers = rooms.get(currentRoomId);
    peers?.delete(peer.peerId);
    if (peers?.size === 0) rooms.delete(currentRoomId);
    void publishSignalingEvent({ type: "peer-left", roomId: currentRoomId, peerId: peer.peerId });
  });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const peer = Array.from(rooms.values()).flatMap((room) => Array.from(room.values())).find((item) => item.socket === socket);
    if (peer && !peer.alive) {
      socket.terminate();
      continue;
    }
    if (peer) peer.alive = false;
    socket.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(port, () => {
  console.log(`Podcazt signaling server listening on :${port}`);
});

async function shutdown() {
  clearInterval(heartbeat);
  wss.clients.forEach((socket) => socket.close(1001, "Server shutting down"));
  await Promise.all([publisher?.quit(), subscriber?.quit(), prisma.$disconnect()]);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
