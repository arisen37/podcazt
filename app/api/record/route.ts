import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { assertRoomAccess } from "@/lib/rooms";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ChunkSchema, CompleteRecordingSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "record", limit: 240, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return receiveChunk(request, user.id);
  }

  return completeRecording(request, user.id);
}

function getBucketName() {
  return getEnv("SUPABASE_VIDEOS_BUCKET", "videos");
}

function getChunkPath(input: {
  ownerId: string;
  roomId: string;
  recordingId: string;
  chunkIndex: number;
}) {
  return `chunks/${input.ownerId}/${input.roomId}/${input.recordingId}/${input.chunkIndex}.webm`;
}

function getFinalRecordingPath(input: { ownerId: string; roomId: string; recordingId: string }) {
  return `recordings/${input.ownerId}/${input.roomId}/${input.recordingId}.webm`;
}

function hashBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function receiveChunk(request: NextRequest, userId: string) {
  const formData = await request.formData();
  const file = formData.get("file");
  const parsed = ChunkSchema.safeParse({
    recordingId: formData.get("recordingId"),
    roomId: formData.get("roomId"),
    chunkIndex: formData.get("chunkIndex"),
    totalChunks: formData.get("totalChunks"),
    sha256: formData.get("sha256") || undefined
  });

  if (!parsed.success) return fail("Invalid chunk payload", 422, parsed.error.flatten());
  if (!(file instanceof File)) return fail("file is required", 422);

  try {
    const room = await assertRoomAccess(parsed.data.roomId, userId);
    const buffer = Buffer.from(await file.arrayBuffer());
    const sha256 = hashBuffer(buffer);

    if (parsed.data.sha256 && parsed.data.sha256 !== sha256) {
      return fail("Chunk hash mismatch", 409, { expected: parsed.data.sha256, received: sha256 });
    }

    const supabase = getSupabaseAdmin();
    const bucket = getBucketName();
    const objectPath = getChunkPath({
      ownerId: room.roomOwnerId,
      roomId: room.id,
      recordingId: parsed.data.recordingId,
      chunkIndex: parsed.data.chunkIndex
    });

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, buffer, {
        contentType: file.type || "video/webm",
        upsert: true
      });

    if (uploadError) throw uploadError;

    return ok({
      accepted: true,
      chunkIndex: parsed.data.chunkIndex,
      objectPath,
      sha256
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to receive chunk", 500);
  }
}

async function completeRecording(request: NextRequest, userId: string) {
  const parsed = CompleteRecordingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid completion payload", 422, parsed.error.flatten());

  try {
    const room = await assertRoomAccess(parsed.data.roomId, userId);
    const supabase = getSupabaseAdmin();
    const bucket = getBucketName();
    const chunkBuffers: Buffer[] = [];

    for (let index = 0; index < parsed.data.totalChunks; index += 1) {
      const chunkPath = getChunkPath({
        ownerId: room.roomOwnerId,
        roomId: room.id,
        recordingId: parsed.data.recordingId,
        chunkIndex: index
      });

      const { data, error } = await supabase.storage.from(bucket).download(chunkPath);
      if (error || !data) {
        throw new Error(`Missing uploaded chunk ${index + 1}/${parsed.data.totalChunks}`);
      }

      chunkBuffers.push(Buffer.from(await data.arrayBuffer()));
    }

    const finalBuffer = Buffer.concat(chunkBuffers);
    const finalSha256 = hashBuffer(finalBuffer);
    const objectPath = getFinalRecordingPath({
      ownerId: room.roomOwnerId,
      roomId: room.id,
      recordingId: parsed.data.recordingId
    });

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, finalBuffer, {
        contentType: "video/webm",
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    const link = publicUrl.publicUrl || objectPath;

    await prisma.video.update({
      where: { id: room.videoId },
      data: { link }
    });

    return ok({
      completed: true,
      videoId: room.videoId,
      link,
      receivedChunks: parsed.data.totalChunks,
      sha256: finalSha256
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to complete recording", 500);
  }
}
