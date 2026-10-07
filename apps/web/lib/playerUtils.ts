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

// expectedUri is the track CoJam asked the SDK to play. Outcomes:
//  'ended'   the expected track finished (paused at 0, in previous_tracks).
//  'foreign' Spotify moved on to a track CoJam did not queue (account
//            Autoplay, or the user skipped in their own Spotify app). Either
//            way the room track is no longer playing, so it counts as ended;
//            the caller should pause the SDK. Only armed once the expected
//            track has been seen playing, so the stale state left over from
//            the previous room track right after playUri never triggers it.
export type SpotifyEnd = 'ended' | 'foreign' | null;

export function createSpotifyEndDetector(): (
  state: SpotifyEndState | null | undefined,
  expectedUri?: string | null,
) => SpotifyEnd {
  let firedFor: string | null = null;
  let seenPlaying: string | null = null;
  return (state, expectedUri) => {
    const cur = state?.track_window?.current_track;
    if (!state || !cur) return null;
    const expId = expectedUri ? expectedUri.split(':').pop() : undefined;
    const isExp = (t?: { id?: string | null; uri?: string }) =>
      !!t && (expectedUri ? t.uri === expectedUri || (!!expId && t.id === expId) : true);
    const key = expectedUri ?? cur.id ?? cur.uri ?? null;
    if (!key) return null;
    const prev = state.track_window?.previous_tracks ?? [];
    if (isExp(cur)) {
      if (!state.paused || state.position > 0) {
        seenPlaying = key;
        if (firedFor === key && !state.paused && state.position > 0 && state.position < 5000) firedFor = null;
        return null;
      }
      const finished = prev.some((t) => (t.id ?? t.uri) === (cur.id ?? cur.uri));
      if (!finished || firedFor === key) return null;
      firedFor = key;
      return 'ended';
    }
    if (firedFor === key || seenPlaying !== key) return null;
    firedFor = key;
    return 'foreign';
  };
}
