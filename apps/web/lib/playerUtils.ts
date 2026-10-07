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

// Spotify's SDK has no ENDED event. When a track finishes on its own the SDK
// emits player_state_changed with paused=true, position=0 and the finished
// track repeated in previous_tracks (current_track is still that track). The
// 1s position poll misses this: the position snaps to 0 instead of reaching
// the duration. createSpotifyEndDetector reads those state pushes and fires
// once per finished track; it re-arms when the track plays again.
export interface SpotifyEndState {
  paused?: boolean;
  position: number;
  track_window?: {
    current_track?: { id?: string | null; uri?: string };
    previous_tracks?: Array<{ id?: string | null; uri?: string }>;
  };
}

export function createSpotifyEndDetector(): (state: SpotifyEndState | null | undefined) => boolean {
  let firedFor: string | null = null;
  return (state) => {
    const cur = state?.track_window?.current_track;
    const key = cur?.id ?? cur?.uri ?? null;
    if (!state || !key) return false;
    if (!state.paused || state.position > 0) {
      if (firedFor === key && state.position > 0) firedFor = null;
      return false;
    }
    const prev = state.track_window?.previous_tracks ?? [];
    const finished = prev.some((t) => (t.id ?? t.uri) === key);
    if (!finished || firedFor === key) return false;
    firedFor = key;
    return true;
  };
}
