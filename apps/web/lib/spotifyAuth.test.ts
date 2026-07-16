import { describe, it, expect } from 'vitest';
import { isTokenValid, type StoredToken } from './spotifyAuth';

const tok = (over: Partial<StoredToken> = {}): StoredToken => ({
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: 1_000_000,
  ...over,
});

describe('isTokenValid', () => {
  it('valid well before expiry', () => {
    expect(isTokenValid(tok({ expiresAt: 1_000_000 }), 900_000)).toBe(true);
  });

  it('invalid after expiry', () => {
    expect(isTokenValid(tok({ expiresAt: 1_000_000 }), 1_000_001)).toBe(false);
  });

  it('invalid within the 60s refresh skew (refresh proactively)', () => {
    expect(isTokenValid(tok({ expiresAt: 1_000_000 }), 999_950)).toBe(false);
  });

  it('null token is invalid', () => {
    expect(isTokenValid(null, 0)).toBe(false);
  });
});
