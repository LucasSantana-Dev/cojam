import { describe, it, expect } from 'vitest';
import { secondsToMs, msToSeconds } from './playerUtils';

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
});
