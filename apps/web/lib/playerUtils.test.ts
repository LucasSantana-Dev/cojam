import { describe, it, expect } from 'vitest';
import { secondsToMs, msToSeconds, createEndedDetector, createSpotifyEndDetector } from './playerUtils';

describe('playerUtils', () => {
  describe('secondsToMs', () => {
    it('converts 0 seconds to 0 ms', () => {
      expect(secondsToMs(0)).toBe(0);
    });

    it('converts 1 second to 1000 ms', () => {
      expect(secondsToMs(1)).toBe(1000);
    });

    it('converts 10.5 seconds to 10500 ms', () => {
      expect(secondsToMs(10.5)).toBe(10500);
    });

    it('rounds fractional milliseconds', () => {
      expect(secondsToMs(1.5555)).toBe(1556);
    });
  });

  describe('msToSeconds', () => {
    it('converts 0 ms to 0 seconds', () => {
      expect(msToSeconds(0)).toBe(0);
    });

    it('converts 1000 ms to 1 second', () => {
      expect(msToSeconds(1000)).toBe(1);
    });

    it('converts 10500 ms to 10.5 seconds', () => {
      expect(msToSeconds(10500)).toBe(10.5);
    });

    it('converts fractional milliseconds', () => {
      expect(msToSeconds(1234)).toBe(1.234);
    });
  });

  describe('round-trip conversions', () => {
    it('round-trips seconds through ms conversions', () => {
      const original = 123.456;
      const ms = secondsToMs(original);
      const roundTrip = msToSeconds(ms);
      expect(roundTrip).toBeCloseTo(original, 3);
    });

    it('round-trips ms through seconds conversions', () => {
      const original = 123456;
      const seconds = msToSeconds(original);
      const roundTrip = secondsToMs(seconds);
      expect(roundTrip).toBeCloseTo(original, 0);
    });
  });

  describe('createEndedDetector', () => {
    it('fires once when playback reaches the end', () => {
      const detect = createEndedDetector();
      expect(detect(179000, 180000)).toBe(false);
      expect(detect(179600, 180000)).toBe(true);
    });

    it('does not refire on subsequent polls at the end', () => {
      const detect = createEndedDetector();
      expect(detect(179600, 180000)).toBe(true);
      expect(detect(179700, 180000)).toBe(false);
      expect(detect(180000, 180000)).toBe(false);
    });

    it('re-arms when a new track starts (duration changes)', () => {
      const detect = createEndedDetector();
      expect(detect(179600, 180000)).toBe(true);
      expect(detect(0, 200000)).toBe(false);
      expect(detect(199600, 200000)).toBe(true);
    });

    it('re-arms when the user rewinds under 50%', () => {
      const detect = createEndedDetector();
      expect(detect(179600, 180000)).toBe(true);
      expect(detect(80000, 180000)).toBe(false);
      expect(detect(179600, 180000)).toBe(true);
    });

    it('never fires with zero duration', () => {
      const detect = createEndedDetector();
      expect(detect(0, 0)).toBe(false);
      expect(detect(1000, 0)).toBe(false);
    });
  });
});

describe('createSpotifyEndDetector', () => {
  const st = (o: { paused: boolean; position: number; cur: string; prev?: string[] }) => ({
    paused: o.paused,
    position: o.position,
    track_window: {
      current_track: { id: o.cur, uri: `spotify:track:${o.cur}` },
      previous_tracks: (o.prev ?? []).map((id) => ({ id, uri: `spotify:track:${id}` })),
    },
  });
  const A = 'spotify:track:a';

  it('normal end: fires once (paused, position 0, track in previous_tracks)', () => {
    const d = createSpotifyEndDetector();
    expect(d(st({ paused: false, position: 1000, cur: 'a' }), A)).toBeNull();
    expect(d(st({ paused: true, position: 0, cur: 'a', prev: ['a'] }), A)).toBe('ended');
    expect(d(st({ paused: true, position: 0, cur: 'a', prev: ['a'] }), A)).toBeNull();
  });

  it('Spotify Autoplay: a foreign track after ours fires once as foreign', () => {
    const d = createSpotifyEndDetector();
    d(st({ paused: false, position: 170_000, cur: 'a' }), A);
    expect(d(st({ paused: false, position: 300, cur: 'zzz', prev: ['a'] }), A)).toBe('foreign');
    expect(d(st({ paused: true, position: 400, cur: 'zzz', prev: ['a'] }), A)).toBeNull();
  });

  it('foreign track without ours in previous_tracks (user skipped in Spotify) also counts as ended', () => {
    const d = createSpotifyEndDetector();
    d(st({ paused: false, position: 20_000, cur: 'a' }), A);
    expect(d(st({ paused: false, position: 100, cur: 'other' }), A)).toBe('foreign');
  });

  it('stale state of the previous room track right after a switch does not fire', () => {
    const d = createSpotifyEndDetector();
    expect(d(st({ paused: false, position: 90_000, cur: 'old' }), A)).toBeNull();
  });

  it('does not fire on a user pause or a fresh paused load', () => {
    const d = createSpotifyEndDetector();
    expect(d(st({ paused: true, position: 42_000, cur: 'a' }), A)).toBeNull();
    expect(d(st({ paused: true, position: 0, cur: 'a' }), A)).toBeNull();
    expect(d(null, A)).toBeNull();
  });

  it('re-arms when the same track plays again', () => {
    const d = createSpotifyEndDetector();
    expect(d(st({ paused: true, position: 0, cur: 'a', prev: ['a'] }), A)).toBe('ended');
    expect(d(st({ paused: false, position: 500, cur: 'a', prev: ['a'] }), A)).toBeNull();
    expect(d(st({ paused: true, position: 0, cur: 'a', prev: ['a'] }), A)).toBe('ended');
  });
});
