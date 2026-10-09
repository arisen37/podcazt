export const RECORDING_PART_SIZE = 8 * 1024 * 1024;

export function completePartSet(parts: Array<{
  PartNumber?: number; ETag?: string; ChecksumSHA256?: string; Size?: number;
}>, byteSize: number) {
  const expectedCount = Math.ceil(byteSize / RECORDING_PART_SIZE);
  return parts.length === expectedCount && parts.every((part, index) =>
    part.PartNumber === index + 1 && Boolean(part.ETag) && Boolean(part.ChecksumSHA256) &&
    part.Size === Math.min(RECORDING_PART_SIZE, byteSize - index * RECORDING_PART_SIZE)
  );
}
