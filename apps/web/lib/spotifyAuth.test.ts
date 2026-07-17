import { describe, it, expect } from 'vitest';
import { isTokenValid, canonicalOrigin, type StoredToken } from './spotifyAuth';

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

describe('canonicalOrigin', () => {
  // Spotify banned localhost redirect URIs; only 127.0.0.1 is accepted.
  it('rewrites localhost to 127.0.0.1, keeping protocol and port', () => {
    expect(
      canonicalOrigin({
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
        origin: 'http://localhost:3000',
      }),
    ).toBe('http://127.0.0.1:3000');
  });

  it('leaves 127.0.0.1 untouched', () => {
    expect(
      canonicalOrigin({
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: '3000',
        origin: 'http://127.0.0.1:3000',
      }),
    ).toBe('http://127.0.0.1:3000');
  });

  it('passes a production https host through unchanged', () => {
    expect(
      canonicalOrigin({
        protocol: 'https:',
        hostname: 'cojam.fly.dev',
        port: '',
        origin: 'https://cojam.fly.dev',
      }),
    ).toBe('https://cojam.fly.dev');
  });
});
