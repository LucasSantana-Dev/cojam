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
  appleAuthorized: false,
  spotifyAuthorized: false,
  ...over,
});

describe('pickSource', () => {
  it('prefers apple when authorized and track has an apple source', () => {
    const t = track({ apple: { songId: '123', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth({ appleAuthorized: true }))).toBe('apple');
  });

  it('falls back to youtube when apple not authorized', () => {
    const t = track({ apple: { songId: '123', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth())).toBe('youtube');
  });

  it('youtube-only track plays youtube even when apple authorized', () => {
    const t = track({ youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth({ appleAuthorized: true }))).toBe('youtube');
  });

  it('no playable source → null', () => {
    expect(pickSource(track({}), auth({ appleAuthorized: true }))).toBeNull();
  });

  it('prefers spotify when authorized and track has a spotify source', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:abc', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth({ spotifyAuthorized: true }))).toBe('spotify');
  });

  it('spotify wins over apple when both authorized and both sources present', () => {
    const t = track({
      spotify: { trackUri: 'spotify:track:abc', confidence: 1 },
      apple: { songId: '123', confidence: 1 },
    });
    expect(pickSource(t, auth({ spotifyAuthorized: true, appleAuthorized: true }))).toBe('spotify');
  });

  it('falls back to youtube when spotify authorized but track has no spotify source', () => {
    const t = track({ youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, auth({ spotifyAuthorized: true }))).toBe('youtube');
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

  it('track with apple source + apple authorized → not unavailable', () => {
    const t = track({ apple: { songId: '123', confidence: 1 } });
    expect(isUnavailable(t, auth({ appleAuthorized: true }))).toBe(false);
  });

  it('track with only apple source but apple not authorized → unavailable', () => {
    const t = track({ apple: { songId: '123', confidence: 1 } });
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
  const all = track({ spotify: { trackUri: 'spotify:track:1', confidence: 1 }, apple: { songId: 'a1', confidence: 1 }, youtube: { videoId: 'v1', confidence: 1 } });
  const both = { spotifyAuthorized: true, appleAuthorized: true };

  it('auto keeps the default order', () => {
    expect(pickSource(all, { ...both, preference: 'auto' })).toBe('spotify');
  });
  it.each(['spotify', 'apple', 'youtube'] as const)('an explicit %s choice wins when it can play', (p) => {
    expect(resolveSource(all, { ...both, preference: p })).toEqual({ source: p, fellBack: false });
  });
  it('youtube wins over a connected Spotify', () => {
    expect(pickSource(all, { ...both, preference: 'youtube' })).toBe('youtube');
  });
  it('falls back to the auto order and says so when the track lacks the chosen service', () => {
    const t = track({ youtube: { videoId: 'v1', confidence: 1 } });
    expect(resolveSource(t, { ...both, preference: 'spotify' })).toEqual({ source: 'youtube', fellBack: true });
  });
  it('falls back when the chosen service is not authorized', () => {
    expect(resolveSource(all, { spotifyAuthorized: false, appleAuthorized: true, preference: 'spotify' })).toEqual({ source: 'apple', fellBack: true });
  });
  it('returns null (still flagged as fallback) when nothing can play', () => {
    const t = track({ spotify: { trackUri: 'spotify:track:1', confidence: 1 } });
    expect(resolveSource(t, { spotifyAuthorized: false, appleAuthorized: false, preference: 'spotify' })).toEqual({ source: null, fellBack: true });
    expect(isUnavailable(t, { spotifyAuthorized: false, appleAuthorized: false, preference: 'youtube' })).toBe(true);
  });
  it('auto never reports a fallback', () => {
    expect(resolveSource(track({}), { ...both, preference: 'auto' })).toEqual({ source: null, fellBack: false });
  });
});

describe('listeningPlatform', () => {
  it('auto is the best authorized service', () => {
    expect(listeningPlatform({ spotifyAuthorized: true, appleAuthorized: true })).toBe('spotify');
    expect(listeningPlatform({ spotifyAuthorized: false, appleAuthorized: true })).toBe('apple');
    expect(listeningPlatform({ spotifyAuthorized: false, appleAuthorized: false })).toBe('youtube');
  });
  it('an explicit choice counts only when usable', () => {
    expect(listeningPlatform({ spotifyAuthorized: true, appleAuthorized: false, preference: 'youtube' })).toBe('youtube');
    expect(listeningPlatform({ spotifyAuthorized: false, appleAuthorized: false, preference: 'spotify' })).toBe('youtube');
    expect(listeningPlatform({ spotifyAuthorized: false, appleAuthorized: true, preference: 'apple' })).toBe('apple');
  });
});
