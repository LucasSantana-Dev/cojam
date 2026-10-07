import { describe, expect, it } from 'vitest';
import { BEAT_MS, beatAt } from './beatClock';

describe('beatAt', () => {
  it('is periodic and peaks on the beat', () => {
    const a = beatAt(5 * BEAT_MS);
    const b = beatAt(12 * BEAT_MS);
    expect(a.pulse).toBeCloseTo(1, 5);
    expect(b.pulse).toBeCloseTo(1, 5);
    expect(beatAt(5.5 * BEAT_MS).pulse).toBeLessThan(0.15);
  });
  it('two clients with the same synced time get the same pulse', () => {
    expect(beatAt(123456789).pulse).toBe(beatAt(123456789).pulse);
  });
});
