import { describe, it, expect, vi } from 'vitest';
import { computeExpectedPosition, shouldCorrect, isExpectedPositionKnown, isPastEnd, PAST_END_GRACE_MS, DRIFT_THRESHOLD_MS } from './playbackSync';

// Mock getClockOffsetMs to control clock offset in tests
vi.mock('./realtime', () => ({
  getClockOffsetMs: vi.fn(() => 0),
}));

describe('playbackSync', () => {
  describe('computeExpectedPosition', () => {
    it('returns 0 for undefined transport', () => {
      expect(computeExpectedPosition(undefined, 1000)).toBe(0);
    });

    it('returns 0 for stopped state', () => {
      const transport = { state: 'stopped' as const, positionMs: 500, updatedAtServerMs: 1000 };
      expect(computeExpectedPosition(transport, 2000)).toBe(0);
    });

    it('returns current position for paused state', () => {
      const transport = { state: 'paused' as const, positionMs: 3000, updatedAtServerMs: 1000 };
      expect(computeExpectedPosition(transport, 2000)).toBe(3000);
    });

    it('advances position by elapsed time when playing', () => {
      const transport = { state: 'playing' as const, positionMs: 5000, updatedAtServerMs: 1000 };
      const serverNowMs = 3500; // 2500ms elapsed
      expect(computeExpectedPosition(transport, serverNowMs)).toBe(7500);
    });

    it('returns 0 when computed position would be negative', () => {
      const transport = { state: 'playing' as const, positionMs: 100, updatedAtServerMs: 5000 };
      const serverNowMs = 1000; // -4000ms "elapsed" (time went backward)
      expect(computeExpectedPosition(transport, serverNowMs)).toBe(0);
    });

    it('handles zero elapsed time for playing state', () => {
      const transport = { state: 'playing' as const, positionMs: 2000, updatedAtServerMs: 1000 };
      expect(computeExpectedPosition(transport, 1000)).toBe(2000);
    });
  });

  describe('shouldCorrect', () => {
    it('returns false when drift is zero', () => {
      expect(shouldCorrect(0, DRIFT_THRESHOLD_MS)).toBe(false);
    });

    it('returns false when drift is below threshold', () => {
      expect(shouldCorrect(500, DRIFT_THRESHOLD_MS)).toBe(false);
      expect(shouldCorrect(-500, DRIFT_THRESHOLD_MS)).toBe(false);
    });

    it('returns false when drift equals threshold', () => {
      expect(shouldCorrect(DRIFT_THRESHOLD_MS, DRIFT_THRESHOLD_MS)).toBe(false);
      expect(shouldCorrect(-DRIFT_THRESHOLD_MS, DRIFT_THRESHOLD_MS)).toBe(false);
    });

    it('returns true when positive drift exceeds threshold', () => {
      expect(shouldCorrect(DRIFT_THRESHOLD_MS + 1, DRIFT_THRESHOLD_MS)).toBe(true);
      expect(shouldCorrect(2000, DRIFT_THRESHOLD_MS)).toBe(true);
    });

    it('returns true when negative drift exceeds threshold', () => {
      expect(shouldCorrect(-(DRIFT_THRESHOLD_MS + 1), DRIFT_THRESHOLD_MS)).toBe(true);
      expect(shouldCorrect(-2000, DRIFT_THRESHOLD_MS)).toBe(true);
    });

    it('respects custom threshold', () => {
      expect(shouldCorrect(100, 50)).toBe(true);
      expect(shouldCorrect(100, 200)).toBe(false);
    });
  });

  describe('DRIFT_THRESHOLD_MS constant', () => {
    it('is greater than 500ms (above cross-service physics floor)', () => {
      expect(DRIFT_THRESHOLD_MS).toBeGreaterThan(500);
    });

    it('is set to 1000ms as default anti-thrash tolerance', () => {
      expect(DRIFT_THRESHOLD_MS).toBe(1000);
    });
  });
});

describe('isExpectedPositionKnown', () => {
  const playing = { state: 'playing' as const, positionMs: 0, updatedAtServerMs: 10_000 };
  it('tolerates small jitter', () => {
    expect(isExpectedPositionKnown(playing, 9_000)).toBe(true);
  });
  it('is unknown when the stamp is far in the future (clock behind)', () => {
    expect(isExpectedPositionKnown(playing, 1_000)).toBe(false);
  });
  it('is always known when paused', () => {
    expect(isExpectedPositionKnown({ ...playing, state: 'paused' }, 0)).toBe(true);
  });
});

describe('isPastEnd (stale transport past the track end)', () => {
  const dur = 223_000;
  const playing = (positionMs: number, updatedAtServerMs: number) =>
    ({ state: 'playing' as const, positionMs, updatedAtServerMs });

  it('is true for the prod case: position 0 stamped 62 minutes ago on a 3:43 track', () => {
    const now = 10_000_000;
    const t = playing(0, now - 62 * 60 * 1000);
    expect(computeExpectedPosition(t, now)).toBeGreaterThan(dur);
    expect(isPastEnd(t, now, dur)).toBe(true);
  });

  it('is false inside the track and inside the grace window', () => {
    const now = 10_000_000;
    expect(isPastEnd(playing(0, now - 60_000), now, dur)).toBe(false);
    expect(isPastEnd(playing(0, now - dur - PAST_END_GRACE_MS + 1), now, dur)).toBe(false);
    expect(isPastEnd(playing(0, now - dur - PAST_END_GRACE_MS), now, dur)).toBe(true);
  });

  it('is false for paused, stopped, missing transport and unknown duration', () => {
    const now = 10_000_000;
    const old = now - 3_600_000;
    expect(isPastEnd({ state: 'paused', positionMs: 0, updatedAtServerMs: old }, now, dur)).toBe(false);
    expect(isPastEnd({ state: 'stopped', positionMs: 0, updatedAtServerMs: old }, now, dur)).toBe(false);
    expect(isPastEnd(undefined, now, dur)).toBe(false);
    expect(isPastEnd(playing(0, old), now, undefined)).toBe(false);
    expect(isPastEnd(playing(0, old), now, 0)).toBe(false);
  });

  it('is false when the clock is wrong (stamp in the future): position unknown, not past the end', () => {
    expect(isPastEnd(playing(500_000, 10_000_000 + 60_000), 10_000_000, dur)).toBe(false);
  });
});
