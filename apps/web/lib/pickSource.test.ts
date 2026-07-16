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

describe('pickSource', () => {
  it('prefers apple when authorized and track has an apple source', () => {
    const t = track({ apple: { songId: '123', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, { appleAuthorized: true })).toBe('apple');
  });

  it('falls back to youtube when apple not authorized', () => {
    const t = track({ apple: { songId: '123', confidence: 1 }, youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, { appleAuthorized: false })).toBe('youtube');
  });

  it('youtube-only track plays youtube even when apple authorized', () => {
    const t = track({ youtube: { videoId: 'v', confidence: 1 } });
    expect(pickSource(t, { appleAuthorized: true })).toBe('youtube');
  });

  it('no playable source → null', () => {
    expect(pickSource(track({}), { appleAuthorized: true })).toBeNull();
  });
});
