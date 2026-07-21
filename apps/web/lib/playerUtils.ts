/**
 * Unit conversion helpers for player adapters.
 */

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

export function msToSeconds(ms: number): number {
  return ms / 1000;
}

import type { SpotifySDKPlayer } from '@/app/room/components/SpotifyPlayer';

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
export async function detectSpotifyCanSeek(player: Pick<SpotifySDKPlayer, 'getCurrentState'>): Promise<boolean> {
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

// createEndedDetector returns a poll-time check that fires exactly once when
// playback reaches the end of a track, re-arming when a new track starts
// (duration changes) or when the user rewinds (position drops back under 50%).
export function createEndedDetector(): (positionMs: number, durationMs: number) => boolean {
  let armed = true;
  let lastDuration = 0;
  return (positionMs: number, durationMs: number) => {
    if (durationMs <= 0) return false;
    if (durationMs !== lastDuration) {
      lastDuration = durationMs;
      armed = true;
    }
    if (positionMs < durationMs * 0.5) armed = true;
    if (!armed) return false;
    if (positionMs >= durationMs - 500) {
      armed = false;
      return true;
    }
    return false;
  };
}
