let lastTimestampMs = 0;

export function getMonotonicTimestamp(now = new Date()): string {
  const currentMs = now.getTime();
  if (!Number.isFinite(currentMs)) {
    throw new Error("Cannot create a monotonic timestamp from an invalid date");
  }

  const nextMs = Math.max(currentMs, lastTimestampMs + 1);
  lastTimestampMs = nextMs;
  return new Date(nextMs).toISOString();
}
