import type { TrackRef } from '@cojam/shared';

// Which platform adapter plays this track for THIS client.
// Priority: an authorized full-track service (Spotify, then Apple) the track
// has a source for; YouTube embed is the universal fallback.
export function pickSource(
  track: TrackRef,
  opts: { appleAuthorized: boolean; spotifyAuthorized: boolean },
): 'spotify' | 'apple' | 'youtube' | null {
  if (opts.spotifyAuthorized && track.sources.spotify?.trackUri) return 'spotify';
  if (opts.appleAuthorized && track.sources.apple?.songId) return 'apple';
  if (track.sources.youtube?.videoId) return 'youtube';
  return null;
}
