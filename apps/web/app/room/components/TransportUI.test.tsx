import { describe, it, expect } from 'vitest';
import { formatTime, playPauseLabel } from './TransportUI';

describe('TransportUI', () => {
  describe('formatTime', () => {
    it('formats zero milliseconds', () => {
      expect(formatTime(0)).toBe('0:00');
    });

    it('formats less than one minute', () => {
      expect(formatTime(30000)).toBe('0:30');
      expect(formatTime(59000)).toBe('0:59');
    });

    it('formats exactly one minute', () => {
      expect(formatTime(60000)).toBe('1:00');
    });

    it('formats multiple minutes', () => {
      expect(formatTime(120000)).toBe('2:00');
      expect(formatTime(125000)).toBe('2:05');
      expect(formatTime(125500)).toBe('2:05');
    });

    it('pads seconds with zero', () => {
      expect(formatTime(65000)).toBe('1:05');
      expect(formatTime(600000)).toBe('10:00');
    });

    it('handles large durations', () => {
      expect(formatTime(3661000)).toBe('61:01');
    });

    it('handles NaN and negative values', () => {
      expect(formatTime(NaN)).toBe('0:00');
      expect(formatTime(-100)).toBe('0:00');
    });

    it('rounds down to nearest second', () => {
      expect(formatTime(1234)).toBe('0:01');
      expect(formatTime(125999)).toBe('2:05');
    });
  });

  describe('transport state mapping', () => {
    it('maps playing state to pause label', () => {
      expect(playPauseLabel('playing')).toBe('Pause');
    });

    it('maps paused state to play label', () => {
      expect(playPauseLabel('paused')).toBe('Play');
    });

    it('maps stopped and undefined state to play label', () => {
      expect(playPauseLabel('stopped')).toBe('Play');
      expect(playPauseLabel(undefined)).toBe('Play');
    });
  });

  describe('seek disabled logic', () => {
    it('is disabled when canSeek is false', () => {
      const canSeek = false;
      expect(canSeek).toBe(false);
    });

    it('is enabled when canSeek is true', () => {
      const canSeek = true;
      expect(canSeek).toBe(true);
    });

    it('provides correct reason text', () => {
      const canSeek = false;
      const reason = !canSeek ? 'Seeking requires Spotify Premium' : '';
      expect(reason).toBe('Seeking requires Spotify Premium');
    });
  });
});
