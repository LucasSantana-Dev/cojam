/**
 * Helper to find the active lyric line index based on current playback position.
 * Returns the index of the last line whose timeMs <= positionMs.
 * Returns -1 if positionMs is before the first line or synced is empty.
 */
export function activeLineIndex(
  synced: { timeMs: number; text: string }[],
  positionMs: number
): number {
  if (synced.length === 0) return -1;
  if (positionMs < synced[0]!.timeMs) return -1;

  for (let i = synced.length - 1; i >= 0; i--) {
    if (synced[i]!.timeMs <= positionMs) {
      return i;
    }
  }

  return -1;
}
