import { describe, it, expect } from 'vitest';
import { pickSource, isUnavailable, resolveSource, listeningPlatform } from './pickSource';
import type { TrackRef } from '@cojam/shared';

const track = (sources: TrackRef['sources']): TrackRef => ({
  id: 't1',
  title: 'T',
  artist: 'A',
  sources,
  addedBy: 'x',
});

const auth = (over: Partial<Parameters<typeof pickSource>[1]> = {}) => ({
  spotifyAuthorized: false,
  ...over,
});

describe('pickSource', () => {
  it('no playable source → null', () => {
    expect(pickSource(track({}), auth({ spotifyAuthorized: true }))).toBeNull();
  });

  it('prefers spotify when authorized and track has a spotify source', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:abc', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth({ spotifyAuthorized: true }))).toBe('spotify');
  });

  it('falls back to youtube when spotify is not authorized', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:abc', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth())).toBe('youtube');
  });

  it('falls back to youtube when spotify authorized but track has no spotify source', () => {
    const t = track({ youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth({ spotifyAuthorized: true }))).toBe('youtube');
  });

  // A queue row persisted before Apple Music was removed (2026-10-08) may still
  // carry an apple source. It is never picked; the other sources still play.
  it('ignores a legacy apple source on a persisted track', () => {
    const legacy = { apple: { songId: '123', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } } as TrackRef['sources'];
    expect(pickSource(track(legacy), auth())).toBe('youtube');
    const appleOnly = { apple: { songId: '123', confidence: 1 } } as TrackRef['sources'];
    expect(pickSource(track(appleOnly), auth({ spotifyAuthorized: true }))).toBeNull();
  });
});

describe('isUnavailable', () => {
  it('track with youtube source → not unavailable', () => {
    const t = track({ youtube: { videoId: 'v', confidence: 1 } });
    expect(isUnavailable(t, auth())).toBe(false);
  });

  it('track with spotify source + spotify authorized → not unavailable', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:abc', confidence: 1 } });
    expect(isUnavailable(t, auth({ spotifyAuthorized: true }))).toBe(false);
  });

  it('track with only spotify source but spotify not authorized → unavailable', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:abc', confidence: 1 } });
    expect(isUnavailable(t, auth())).toBe(true);
  });

  it('track with no sources → unavailable', () => {
    const t = track({});
    expect(isUnavailable(t, auth())).toBe(true);
  });

  it('null track → not unavailable (should not happen in practice)', () => {
    expect(isUnavailable(null as any, auth())).toBe(false);
  });
});

describe('pickSource with a listening preference', () => {
  const all = track({ spotify: { trackUri: 'spotify:track:1', confidence: 1 }, youtube: { videoId: 'v1', confidence: 1 } });
  const connected = { spotifyAuthorized: true };

  it('auto keeps the default order', () => {
    expect(pickSource(all, { ...connected, preference: 'auto' })).toBe('spotify');
  });
  it.each(['spotify', 'youtube'] as const)('an explicit %s choice wins when it can play', (p) => {
    expect(resolveSource(all, { ...connected, preference: p })).toEqual({ source: p, fellBack: false, reason: null });
  });
  it('youtube wins over a connected Spotify', () => {
    expect(pickSource(all, { ...connected, preference: 'youtube' })).toBe('youtube');
  });
  it('falls back to the auto order and says so when the track lacks the chosen service', () => {
    const t = track({ youtube: { videoId: 'v1', confidence: 1 } });
    expect(resolveSource(t, { ...connected, preference: 'spotify' })).toEqual({ source: 'youtube', fellBack: true, reason: 'no-version' });
  });
  it('falls back when the chosen service is not authorized', () => {
    expect(resolveSource(all, { spotifyAuthorized: false, preference: 'spotify' })).toEqual({ source: 'youtube', fellBack: true, reason: 'not-connected' });
  });
  it('returns null (still flagged as fallback) when nothing can play', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:1', confidence: 1 } });
    expect(resolveSource(t, { spotifyAuthorized: false, preference: 'spotify' })).toEqual({ source: null, fellBack: true, reason: 'not-connected' });
    expect(isUnavailable(t, { spotifyAuthorized: false, preference: 'youtube' })).toBe(true);
  });
  it('auto never reports a fallback', () => {
    expect(resolveSource(track({}), { ...connected, preference: 'auto' })).toEqual({ source: null, fellBack: false, reason: null });
  });
});

describe('listeningPlatform', () => {
  it('auto is the best authorized service', () => {
    expect(listeningPlatform({ spotifyAuthorized: true })).toBe('spotify');
    expect(listeningPlatform({ spotifyAuthorized: false })).toBe('youtube');
  });
  it('an explicit choice counts only when usable', () => {
    expect(listeningPlatform({ spotifyAuthorized: true, preference: 'youtube' })).toBe('youtube');
    expect(listeningPlatform({ spotifyAuthorized: false, preference: 'spotify' })).toBe('youtube');
  });
});
