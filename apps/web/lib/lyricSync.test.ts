import { describe, it, expect } from 'vitest';
import { activeLineIndex } from './lyricSync';

describe('activeLineIndex', () => {
  const synced = [
    { timeMs: 1000, text: 'First line' },
    { timeMs: 5000, text: 'Second line' },
    { timeMs: 10000, text: 'Third line' },
    { timeMs: 15000, text: 'Fourth line' },
  ];

  it('returns -1 when synced is empty', () => {
    expect(activeLineIndex([], 5000)).toBe(-1);
  });

  it('returns -1 when position is before first line', () => {
    expect(activeLineIndex(synced, 500)).toBe(-1);
  });

  it('returns 0 when position is exactly on first line', () => {
    expect(activeLineIndex(synced, 1000)).toBe(0);
  });

  it('returns correct index when position is between two lines', () => {
    expect(activeLineIndex(synced, 7000)).toBe(1);
  });

  it('returns correct index when position is exactly on a line', () => {
    expect(activeLineIndex(synced, 10000)).toBe(2);
  });

  it('returns last index when position is after last line', () => {
    expect(activeLineIndex(synced, 20000)).toBe(3);
  });

  it('returns last index when position is at last line boundary', () => {
    expect(activeLineIndex(synced, 15000)).toBe(3);
  });

  it('handles single-line lyrics', () => {
    const singleLine = [{ timeMs: 2000, text: 'Only line' }];
    expect(activeLineIndex(singleLine, 1000)).toBe(-1);
    expect(activeLineIndex(singleLine, 2000)).toBe(0);
    expect(activeLineIndex(singleLine, 5000)).toBe(0);
  });
});
