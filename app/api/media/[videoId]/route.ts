import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getS3, getS3Bucket, usesS3 } from "@/lib/s3";

export async function GET(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);
  if (!usesS3()) return fail("S3 storage is not enabled", 404);
  const { videoId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(videoId)) return fail("Invalid video ID", 422);
  const video = await prisma.video.findFirst({
    where: { id: videoId, completedAt: { not: null }, room: { roomOwnerId: user.id } }
  });
  if (!video?.storagePath) return fail("Recording not found", 404);
  const preview = request.nextUrl.searchParams.get("preview") === "1";
  const key = preview ? `recordings/${video.id}/preview.jpg` : video.storagePath;
  const url = await getSignedUrl(getS3(), new GetObjectCommand({
    Bucket: getS3Bucket(), Key: key
  }), { expiresIn: 3600 });
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
