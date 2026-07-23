import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './relativeTime';

describe('formatRelativeTime', () => {
  const now = 1_800_000_000_000;

  it('returns null when the timestamp is missing or 0 (pre-timestamp data)', () => {
    expect(formatRelativeTime(undefined, now)).toBeNull();
    expect(formatRelativeTime(0, now)).toBeNull();
  });

  it('is "just now" under 45s, clamping slight future skew', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
    expect(formatRelativeTime(now + 5_000, now)).toBe('just now');
  });

  it('rounds to minutes under an hour', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1m ago');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });

  it('rounds to hours under a day', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });

  it('rounds to days beyond that', () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
