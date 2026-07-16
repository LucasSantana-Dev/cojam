import { describe, it, expect } from 'vitest';
import { pickSource } from './pickSource';
import type { TrackRef } from '@music-jam/shared';

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
