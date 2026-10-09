import { getUploadSession, saveUploadSession, type UploadSession } from "@/lib/recording-store";
import { selectiveRepeat } from "@/lib/selective-repeat";

type Status = { completed?: boolean; videoId?: string; parts?: Array<{ partNumber: number; checksum: string; size: number }> };

class ExpiredUpload extends Error {}

async function api<T>(input: object): Promise<T> {
  const response = await fetch("/api/record/s3", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  if (response.status === 410) throw new ExpiredUpload(body.error);
  if (!response.ok) throw new Error(body.error || "Upload request failed");
  return body as T;
}

async function checksum(blob: Blob) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...hash));
}

export async function uploadRecordingToS3(recordingId: string, roomId: string, blobs: Blob[], progress: (text: string) => void) {
  const recording = new Blob(blobs, { type: "video/webm" });
  let session = await getUploadSession(recordingId);
  let status: Status = {};
  if (session) {
    try { status = await api<Status>({ action: "status", token: session.token }); }
    catch (error) {
      if (!(error instanceof ExpiredUpload)) throw error;
      await saveUploadSession(recordingId, null);
      session = undefined;
    }
    if (status.completed && status.videoId) return status.videoId;
  }
  if (!session) {
    const result = await api<Omit<UploadSession, "recordingId">>({
      action: "init", recordingId, roomId, byteSize: recording.size
    });
    session = { ...result, recordingId };
    await saveUploadSession(recordingId, session);
  }
  const { token, partSize, partCount } = session;
  const acknowledged = new Map((status.parts ?? []).map((part) => [part.partNumber, part]));
  let done = 0;
  progress(`Uploading ${done}/${partCount}`);
  await selectiveRepeat(Array.from({ length: partCount }, (_, index) => index + 1), async (partNumber) => {
    const part = recording.slice((partNumber - 1) * partSize, partNumber * partSize);
    const digest = await checksum(part);
    const previous = acknowledged.get(partNumber);
    if (!previous || previous.checksum !== digest || previous.size !== part.size) {
      const { url } = await api<{ url: string }>({ action: "part", token, partNumber, checksum: digest });
      const response = await fetch(url, {
        method: "PUT", headers: { "x-amz-checksum-sha256": digest }, body: part,
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok) throw new Error(`Part ${partNumber} was not acknowledged. Retry the upload.`);
      // S3 verifies this checksum before returning a successful acknowledgement.
      acknowledged.set(partNumber, { partNumber, checksum: digest, size: part.size });
    }
    progress(`Uploading ${++done}/${partCount}`);
  });
  let completed: Status | undefined;
  await selectiveRepeat([0], async () => {
    completed = await api<Status>({ action: "complete", token });
  });
  if (!completed?.completed || !completed.videoId) throw new Error("Storage did not confirm completion");
  return completed.videoId;
}
