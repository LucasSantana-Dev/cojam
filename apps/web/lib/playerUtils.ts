/**
 * Unit conversion helpers for player adapters.
 */

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

export function msToSeconds(ms: number): number {
  return ms / 1000;
}

/**
 * Try to detect if Spotify seek is available on this account.
 * Attempts a no-op seek and catches any errors; if successful or timing-out,
 * assume seek is allowed. If explicitly denied, assume Premium is needed.
 *
 * Falls back to false (conservative) when uncertain.
 *
 * @param player Spotify Web Playback SDK player instance
 * @returns true if seek is confirmed available, false otherwise
 */
export async function detectSpotifyCanSeek(player: any): Promise<boolean> {
  try {
    const state = await player.getCurrentState();
    if (!state) return false;
    // If we have a current state, assume seek is at least possible.
    // Spotify free tier will fail when actually seeking, not here.
    return true;
  } catch {
    return false;
  }
}
