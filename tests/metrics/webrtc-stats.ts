export type StatsRow = {
  id: string; type: string; timestamp: number; kind?: string; mediaType?: string;
  packetsReceived?: number; packetsLost?: number; jitter?: number;
  framesDecoded?: number; framesDropped?: number; frameWidth?: number; frameHeight?: number;
  selectedCandidatePairId?: string; localCandidateId?: string; remoteCandidateId?: string;
  candidateType?: string; protocol?: string; relayProtocol?: string;
  currentRoundTripTime?: number; state?: string; nominated?: boolean;
};
export function counterDelta(before?: number, after?: number) {
  return typeof before === "number" && typeof after === "number" && Number.isFinite(before) &&
    Number.isFinite(after) && before >= 0 && after >= before ? after - before : null;
}
export function mediaIntervals(before: StatsRow[], after: StatsRow[]) {
  const previous = new Map(before.map((row) => [row.id, row]));
  return after.filter((row) => row.type === "inbound-rtp" && (row.kind ?? row.mediaType) === "video").map((row) => {
    const start = previous.get(row.id);
    const elapsedSeconds = start ? (row.timestamp - start.timestamp) / 1000 : 0;
    const received = counterDelta(start?.packetsReceived, row.packetsReceived);
    const decoded = counterDelta(start?.framesDecoded, row.framesDecoded);
    const dropped = counterDelta(start?.framesDropped, row.framesDropped);
    const rawLost = start && typeof start.packetsLost === "number" && typeof row.packetsLost === "number"
      ? row.packetsLost - start.packetsLost : null;
    const lost = rawLost === null ? null : Math.max(0, rawLost);
    return {
      id: row.id, validTime: elapsedSeconds > 0, elapsedSeconds, received, rawLostDelta: rawLost, lost,
      lateLossCorrection: rawLost === null ? null : Math.max(0, -rawLost),
      packetLossPercent: received !== null && lost !== null && received + lost > 0 ? lost / (received + lost) * 100 : null,
      decoded, dropped,
      decodeDropPercent: decoded !== null && dropped !== null && decoded + dropped > 0 ? dropped / (decoded + dropped) * 100 : null,
      decodedFps: decoded !== null && elapsedSeconds > 0 ? decoded / elapsedSeconds : null,
      jitterMs: typeof row.jitter === "number" && Number.isFinite(row.jitter) && row.jitter >= 0 ? row.jitter * 1000 : null,
      width: row.frameWidth ?? null, height: row.frameHeight ?? null
    };
  });
}
export function selectedPath(rows: StatsRow[]) {
  const pairId = rows.find((row) => row.type === "transport" && row.selectedCandidatePairId)?.selectedCandidatePairId;
  const pair = pairId ? rows.find((row) => row.id === pairId)
    : rows.find((row) => row.type === "candidate-pair" && row.nominated && row.state === "succeeded");
  if (!pair) return null;
  const local = rows.find((row) => row.id === pair.localCandidateId);
  const remote = rows.find((row) => row.id === pair.remoteCandidateId);
  return {
    pairId: pair.id, localType: local?.candidateType ?? null, remoteType: remote?.candidateType ?? null,
    protocol: local?.protocol ?? null, relayProtocol: local?.relayProtocol ?? null,
    rttMs: typeof pair.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime)
      ? pair.currentRoundTripTime * 1000 : null
  };
}
