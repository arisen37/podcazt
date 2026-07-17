import { NextRequest } from "next/server";
import { fail, ok, enforceRateLimit } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { assertRoomAccess } from "@/lib/rooms";
import { getSupabaseAdmin } from "@/lib/supabase";
import { FrameUploadSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, { key: "frame", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);

  const formData = await request.formData();
  const file = formData.get("file");
  const parsed = FrameUploadSchema.safeParse({
    roomId: formData.get("roomId"),
    videoId: formData.get("videoId"),
    recordingId: formData.get("recordingId")
  });

  if (!parsed.success) return fail("Invalid frame payload", 422, parsed.error.flatten());
  if (!(file instanceof File)) return fail("file is required", 422);

  try {
    const room = await assertRoomAccess(parsed.data.roomId, user.id);
    if (room.videoId !== parsed.data.videoId) {
      return fail("Video does not belong to this room", 403);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) return fail("Frame image is empty", 422);

    const bucket = getEnv("SUPABASE_VIDEOS_BUCKET", "videos");
    const objectPath = `frames/${room.roomOwnerId}/${room.id}/${parsed.data.recordingId}.png`;
    const supabase = getSupabaseAdmin();
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, buffer, {
        contentType: file.type || "image/png",
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    const link = publicUrl.publicUrl || objectPath;
    const frame = await prisma.frame.create({
      data: {
        videoId: parsed.data.videoId,
        link
      }
    });

    return ok({ frame });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to upload frame", 500);
  }
}
