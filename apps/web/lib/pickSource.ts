import type { TrackRef } from '@cojam/shared';

export type Source = 'spotify' | 'apple' | 'youtube';
// What the person chose: a fixed service, or 'auto' (best one that can play).
export type ServicePreference = 'auto' | Source;

export interface PickOptions {
  appleAuthorized: boolean;
  spotifyAuthorized: boolean;
  // Omitted means 'auto'.
  preference?: ServicePreference;
}

function canPlay(track: TrackRef, source: Source, opts: PickOptions): boolean {
  if (source === 'spotify') return opts.spotifyAuthorized && Boolean(track.sources.spotify?.trackUri);
  if (source === 'apple') return opts.appleAuthorized && Boolean(track.sources.apple?.songId);
  return Boolean(track.sources.youtube?.videoId);
}

const AUTO_ORDER: readonly Source[] = ['spotify', 'apple', 'youtube'];

// Which platform adapter plays this track for THIS client, and whether an
// explicit choice had to be overridden. An explicit choice wins when that
// service can play the track; otherwise the auto order (an authorized
// full-track service the track has a source for, then the YouTube embed)
// applies and `fellBack` is true so the UI can say so.
export function resolveSource(
  track: TrackRef,
  opts: PickOptions,
): { source: Source | null; fellBack: boolean } {
  const pref = opts.preference ?? 'auto';
  if (pref !== 'auto' && canPlay(track, pref, opts)) return { source: pref, fellBack: false };
  const source = AUTO_ORDER.find((s) => canPlay(track, s, opts)) ?? null;
  return { source, fellBack: pref !== 'auto' };
}

export function pickSource(track: TrackRef, opts: PickOptions): Source | null {
  return resolveSource(track, opts).source;
}

// Whether a track has no playable source for this client.
// True means the track is unavailable (pickSource returns null).
export function isUnavailable(track: TrackRef | null, opts: PickOptions): boolean {
  if (!track) return false;
  return pickSource(track, opts) === null;
}

// The service this person listens through at account level (track-independent,
// so it is stable across the queue): what goes in the presence badge. An
// explicit choice counts when it is usable at all (Spotify and Apple need an
// authorized account; YouTube always); 'auto' is the best authorized service.
export function listeningPlatform(opts: PickOptions): Source {
  const pref = opts.preference ?? 'auto';
  if (pref === 'youtube') return 'youtube';
  if (pref === 'spotify' && opts.spotifyAuthorized) return 'spotify';
  if (pref === 'apple' && opts.appleAuthorized) return 'apple';
  if (opts.spotifyAuthorized) return 'spotify';
  if (opts.appleAuthorized) return 'apple';
  return 'youtube';
}
