import { S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "@/lib/env";

let client: S3Client | undefined;

export function usesS3() {
  return process.env.STORAGE_PROVIDER === "s3";
}

export function getS3() {
  client ??= new S3Client({ region: getEnv("AWS_REGION", "ap-south-1") });
  return client;
}

export function getS3Bucket() {
  return getEnv("S3_BUCKET");
}

export function mediaUrl(videoId: string, preview = false) {
  return `/api/media/${videoId}${preview ? "?preview=1" : ""}`;
}
