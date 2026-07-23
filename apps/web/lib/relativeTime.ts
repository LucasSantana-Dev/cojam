// Relative "x ago" label for server-stamped unix-ms timestamps
// (TrackRef.addedAt, RoomState.createdAt). Returns null when the timestamp is
// missing or 0 (rooms/tracks from before the server stamped them) so the UI
// can stay silent instead of showing a fake time.
export function formatRelativeTime(timestampMs: number | undefined, nowMs: number = Date.now()): string | null {
  if (!timestampMs) return null;
  const elapsedMs = nowMs - timestampMs;
  if (elapsedMs < 45_000) return 'just now'; // also clamps slight future skew
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
