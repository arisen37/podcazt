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
    const video = await tx.video.create({
      data: {
        ownerId: input.user.id,
        name: roomName,
        link: null
      }
    });

    const room = await tx.room.create({
      data: {
        roomOwnerId: input.user.id,
        videoId: video.id,
        name: roomName,
        kind: routeKindToPrisma(input.kind),
        members: {
          connect: { id: input.user.id }
        }
      },
      include: { members: true, video: true }
    });

    return { room, video };
  });
}

export async function assertRoomAccess(roomId: string, userId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      members: {
        select: { id: true }
      }
    }
  });

  if (!room) throw new Error("Room not found");
  if (room.roomOwnerId !== userId && !room.members.some((member) => member.id === userId)) {
    throw new Error("You do not have access to this room");
  }

  return room;
}
