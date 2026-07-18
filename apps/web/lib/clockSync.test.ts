import { describe, it, expect } from 'vitest';
import { estimateOffset, serverNow, type PingSample } from './clockSync';

describe('clockSync', () => {
  describe('estimateOffset', () => {
    it('should return zeros for empty samples', () => {
      const result = estimateOffset([]);
      expect(result.offsetMs).toBe(0);
      expect(result.rttMs).toBe(0);
    });

    it('should compute offset from a single sample', () => {
      const samples: PingSample[] = [
        { t0: 1000, serverNowMs: 1100, t1: 1200 }
      ];
      const result = estimateOffset(samples);
      expect(result.rttMs).toBe(200); // t1 - t0 = 1200 - 1000
      expect(result.offsetMs).toBe(0); // 1100 - (1000 + 1200) / 2 = 1100 - 1100 = 0
    });

    it('should pick the min-RTT sample when multiple are provided', () => {
      const samples: PingSample[] = [
        { t0: 1000, serverNowMs: 1100, t1: 1400 }, // RTT = 400, offset = 1100 - 1200 = -100
        { t0: 2000, serverNowMs: 2150, t1: 2100 }, // RTT = 100, offset = 2150 - 2050 = 100 (min RTT)
        { t0: 3000, serverNowMs: 3200, t1: 3300 }, // RTT = 300, offset = 3200 - 3150 = 50
      ];
      const result = estimateOffset(samples);
      expect(result.rttMs).toBe(100);
      expect(result.offsetMs).toBe(100);
    });

    it('should handle negative offsets', () => {
      const samples: PingSample[] = [
        { t0: 1000, serverNowMs: 900, t1: 1100 }
      ];
      const result = estimateOffset(samples);
      expect(result.rttMs).toBe(100);
      expect(result.offsetMs).toBe(-150); // 900 - (1000 + 1100) / 2 = 900 - 1050 = -150
    });

    it('should compute correctly with zero RTT', () => {
      const samples: PingSample[] = [
        { t0: 1000, serverNowMs: 1050, t1: 1000 }
      ];
      const result = estimateOffset(samples);
      expect(result.rttMs).toBe(0);
      expect(result.offsetMs).toBe(50);
    });
  });

  describe('serverNow', () => {
    it('should add offset to current time', () => {
      const now = Date.now();
      const offset = 100;
      const result = serverNow(offset);
      expect(result).toBeGreaterThanOrEqual(now + offset);
      expect(result).toBeLessThanOrEqual(now + offset + 10); // small buffer for test execution
    });

    it('should handle negative offsets', () => {
      const now = Date.now();
      const offset = -100;
      const result = serverNow(offset);
      expect(result).toBeLessThanOrEqual(now + offset + 10);
    });

    it('should return zero offset plus current time', () => {
      const now = Date.now();
      const result = serverNow(0);
      expect(result).toBeGreaterThanOrEqual(now);
      expect(result).toBeLessThanOrEqual(now + 10);
    });
  });
});
