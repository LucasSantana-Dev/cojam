import { describe, it, expect } from 'vitest';
import { skipVotesNeeded, skipVoteKey } from './skipVote';

describe('skipVotesNeeded', () => {
  it('returns 1 when alone (n=1)', () => {
    expect(skipVotesNeeded(1)).toBe(1);
  });

  it('returns 2 for n=2 (never fewer than 2 when two or more are present)', () => {
    expect(skipVotesNeeded(2)).toBe(2);
  });

  it('returns 2 for n=3 (ceil(3/2)=2)', () => {
    expect(skipVotesNeeded(3)).toBe(2);
  });

  it('returns 2 for n=4 (ceil(4/2)=2)', () => {
    expect(skipVotesNeeded(4)).toBe(2);
  });

  it('returns 3 for n=5 (ceil(5/2)=3)', () => {
    expect(skipVotesNeeded(5)).toBe(3);
  });

  it('returns 1 for n=0 (Math.max(1, 0) clamps to 1)', () => {
    expect(skipVotesNeeded(0)).toBe(1);
  });
});

describe('skipVoteKey', () => {
  it('prefixes the track id with "skip:"', () => {
    expect(skipVoteKey('abc-123')).toBe('skip:abc-123');
  });

  it('does not collide with bare track id keys used for queue votes', () => {
    const trackId = 'abc-123';
    expect(skipVoteKey(trackId)).not.toBe(trackId);
    expect(skipVoteKey(trackId).startsWith('skip:')).toBe(true);
  });
});
