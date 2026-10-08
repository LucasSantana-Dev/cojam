import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './relativeTime';

describe('formatRelativeTime', () => {
  const now = 1_800_000_000_000;

  it('returns null when the timestamp is missing or 0 (pre-timestamp data)', () => {
    expect(formatRelativeTime(undefined, now)).toBeNull();
    expect(formatRelativeTime(0, now)).toBeNull();
  });

  it('is "agora há pouco" under 45s, clamping slight future skew', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('agora há pouco');
    expect(formatRelativeTime(now + 5_000, now)).toBe('agora há pouco');
  });

  it('rounds to minutes under an hour', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('há 1 min');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('há 5 min');
  });

  it('rounds to hours under a day', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('há 3 h');
  });

  it('rounds to days beyond that', () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('há 2 d');
  });
});
