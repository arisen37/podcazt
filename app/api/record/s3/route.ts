import {
  CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand,
  ListPartsCommand, UploadPartCommand, type Part
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { jwtVerify, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { enforceRateLimit, fail, ok } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { assertRoomAccess } from "@/lib/rooms";
import { getS3, getS3Bucket, mediaUrl, usesS3 } from "@/lib/s3";
import { completePartSet, RECORDING_PART_SIZE as PART_SIZE } from "@/lib/multipart";

export const runtime = "nodejs";
const sessionSchema = z.object({
  userId: z.string().uuid(), roomId: z.string().uuid(), videoId: z.string().uuid(),
  recordingId: z.string().uuid(), uploadId: z.string(), key: z.string(),
  byteSize: z.number().int().positive().max(5 * 1024 ** 3), partCount: z.number().int().positive()
});
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("init"), roomId: z.string().uuid(), recordingId: z.string().uuid(),
    byteSize: z.number().int().positive().max(5 * 1024 ** 3) }),
  z.object({ action: z.literal("status"), token: z.string().max(4096) }),
  z.object({ action: z.literal("part"), token: z.string().max(4096), partNumber: z.number().int().positive(),
    checksum: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }),
  z.object({ action: z.literal("complete"), token: z.string().max(4096) })
]);
const signingKey = () => new TextEncoder().encode(getEnv("SESSION_SECRET"));

async function listParts(key: string, uploadId: string) {
  const parts: Part[] = [];
  let marker: string | undefined;
  do {
    const result = await getS3().send(new ListPartsCommand({
      Bucket: getS3Bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker
    }));
    parts.push(...(result.Parts ?? []));
    marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return fail("Unauthorized", 401);
  if (!usesS3()) return fail("S3 storage is not enabled", 404);
  const limited = await enforceRateLimit(request, { key: "s3-record", limit: 600, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("Invalid upload request", 422);
  const input = parsed.data;

  try {
    if (input.action === "init") {
      const room = await assertRoomAccess(input.roomId, user.id);
      if (room.roomOwnerId !== user.id) return fail("Only the owner can upload", 403);
      const key = `recordings/${room.videoId}/${input.recordingId}.webm`;
      const result = await getS3().send(new CreateMultipartUploadCommand({
        Bucket: getS3Bucket(), Key: key, ContentType: "video/webm", ChecksumAlgorithm: "SHA256",
        Metadata: { "recording-id": input.recordingId }
      }));
      if (!result.UploadId) throw new Error("S3 did not return an upload ID");
      const session = {
        userId: user.id, roomId: room.id, videoId: room.videoId, recordingId: input.recordingId,
        uploadId: result.UploadId, key, byteSize: input.byteSize, partCount: Math.ceil(input.byteSize / PART_SIZE)
      };
      const token = await new SignJWT(session).setProtectedHeader({ alg: "HS256" })
        .setIssuer("podcazt").setAudience("s3-upload").setIssuedAt().setExpirationTime("7d").sign(signingKey());
      return ok({ token, partSize: PART_SIZE, partCount: session.partCount });
    }

    let session: z.infer<typeof sessionSchema>;
    try {
      const { payload } = await jwtVerify(input.token, signingKey(), {
        algorithms: ["HS256"], issuer: "podcazt", audience: "s3-upload"
      });
      session = sessionSchema.parse(payload);
    } catch {
      return fail("Upload session expired; start a new upload", 410);
    }
    if (session.userId !== user.id) return fail("Upload access denied", 403);
    const room = await prisma.room.findFirst({ where: { id: session.roomId, roomOwnerId: user.id } });
    if (!room) return fail("Room access denied", 403);
    const saveCompleted = async () => {
      await prisma.video.update({ where: { id: session.videoId }, data: {
        storagePath: session.key, link: mediaUrl(session.videoId), mimeType: "video/webm",
        byteSize: BigInt(session.byteSize), sha256: null, completedAt: new Date()
      } });
      return ok({ completed: true, videoId: session.videoId });
    };

    if (input.action === "part") {
      if (room.closedAt) return fail("Room is closed", 409);
      if (input.partNumber > session.partCount) return fail("Invalid part number", 422);
      const url = await getSignedUrl(getS3(), new UploadPartCommand({
        Bucket: getS3Bucket(), Key: session.key, UploadId: session.uploadId,
        PartNumber: input.partNumber, ChecksumSHA256: input.checksum
      }), { expiresIn: 900, unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) });
      return ok({ url });
    }

    // Reconcile a lost completion response before consulting multipart state.
    try {
      const object = await getS3().send(new HeadObjectCommand({ Bucket: getS3Bucket(), Key: session.key }));
      if (object.ContentLength === session.byteSize && object.Metadata?.["recording-id"] === session.recordingId) {
        return await saveCompleted();
      }
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    }
    let parts: Part[];
    try {
      parts = await listParts(session.key, session.uploadId);
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchUpload") return fail("Upload expired; start again", 410);
      throw error;
    }
    if (input.action === "status") {
      return ok({ parts: parts.map((part) => ({
        partNumber: part.PartNumber, checksum: part.ChecksumSHA256, size: part.Size
      })) });
    }
    if (!completePartSet(parts, session.byteSize)) return fail("Upload is missing verified parts", 409);
    await getS3().send(new CompleteMultipartUploadCommand({
      Bucket: getS3Bucket(), Key: session.key, UploadId: session.uploadId,
      MultipartUpload: { Parts: parts.map(({ PartNumber, ETag, ChecksumSHA256 }) => ({ PartNumber, ETag, ChecksumSHA256 })) }
    }));
    return await saveCompleted();
  } catch (error) {
    console.error("S3 recording request failed", error);
    return fail("Recording storage is temporarily unavailable; your local recording is retained", 503);
  }
}
