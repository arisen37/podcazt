import { RoomKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/types";

export function roomKindToRoute(kind: RoomKind) {
  return kind === RoomKind.PODCAST ? "podcast" : "self-record";
}

export function routeKindToPrisma(kind: "podcast" | "self-record") {
  return kind === "podcast" ? RoomKind.PODCAST : RoomKind.SELF_RECORD;
}

export async function createRoomForUser(input: {
  user: SessionUser;
  name?: string;
  kind: "podcast" | "self-record";
}) {
  const roomName =
    input.name?.trim() ||
    (input.kind === "podcast" ? "Untitled podcast" : "Untitled self recording");

  return prisma.$transaction(async (tx) => {
    const room = await tx.room.create({
      data: {
        roomOwnerId: input.user.id,
        name: roomName,
        kind: routeKindToPrisma(input.kind)
      }
    });

    const video = await tx.video.create({
      data: { roomId: room.id }
    });

    return { room, video };
  });
}

export async function assertRoomAccess(roomId: string, userId: string) {
  const room = await prisma.room.findFirst({
    where: {
      id: roomId,
      closedAt: null,
      OR: [
        { roomOwnerId: userId },
        { members: { some: { userId } } }
      ]
    },
    include: {
      recording: { select: { id: true } }
    }
  });

  if (!room) throw new Error("Room is closed, missing, or access was denied");
  if (!room.recording) throw new Error("Room recording metadata is missing");

  return { ...room, videoId: room.recording.id };
}

export async function getRoomRoster(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      owner: { select: { id: true, name: true, username: true } },
      members: {
        orderBy: { joinedAt: "asc" },
        select: { user: { select: { id: true, name: true, username: true } } }
      }
    }
  });

  if (!room) return [];
  return [room.owner, ...room.members.map((membership) => membership.user)];
}
