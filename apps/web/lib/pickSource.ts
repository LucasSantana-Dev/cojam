import type { TrackRef } from '@music-jam/shared';

// Which platform adapter plays this track for THIS client.
// Apple wins when the user has authorized Apple Music (full tracks, own account);
// YouTube embed is the universal fallback.
export function pickSource(
  track: TrackRef,
  opts: { appleAuthorized: boolean },
): 'apple' | 'youtube' | null {
  if (opts.appleAuthorized && track.sources.apple?.songId) return 'apple';
  if (track.sources.youtube?.videoId) return 'youtube';
  return null;
}
