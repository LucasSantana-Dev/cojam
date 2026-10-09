import { describe, it, expect } from 'vitest';
import { pickScale } from './palcoScale';

describe('pickScale', () => {
  it('picks the largest integer that fits', () => {
    expect(pickScale(480, 1440)).toBe(3);
    expect(pickScale(480, 1439)).toBe(2);
    expect(pickScale(480, 1920)).toBe(4);
    expect(pickScale(195, 390)).toBe(2);
    expect(pickScale(195, 389)).toBe(1);
  });

  it('never goes below 1, even when the art is wider than the space', () => {
    expect(pickScale(480, 320)).toBe(1);
    expect(pickScale(195, 0)).toBe(1);
    expect(pickScale(0, 800)).toBe(1);
    expect(pickScale(480, Number.NaN)).toBe(1);
  });
});
