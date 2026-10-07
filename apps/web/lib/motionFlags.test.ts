import { describe, expect, it } from 'vitest';
import { parseMotion } from './motionFlags';

describe('parseMotion', () => {
  it('turns every moment on by default', () => {
    expect(parseMotion(false)).toEqual({ scrollstory: true, wave: true, flip: true, ground: true, reduced: false });
  });
  it('reduced motion keeps only the static wave', () => {
    const m = parseMotion(true);
    expect([m.scrollstory, m.wave, m.flip, m.ground, m.reduced]).toEqual([false, true, false, false, true]);
  });
});
