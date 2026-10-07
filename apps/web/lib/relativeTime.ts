// Relative "x ago" label for server-stamped unix-ms timestamps
// (TrackRef.addedAt, RoomState.createdAt). Returns null when the timestamp is
// missing or 0 (rooms/tracks from before the server stamped them) so the UI
// can stay silent instead of showing a fake time.
export function formatRelativeTime(timestampMs: number | undefined, nowMs: number = Date.now()): string | null {
  if (!timestampMs) return null;
  const elapsedMs = nowMs - timestampMs;
  if (elapsedMs < 45_000) return 'agora há pouco'; // also clamps slight future skew
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} d`;
}
