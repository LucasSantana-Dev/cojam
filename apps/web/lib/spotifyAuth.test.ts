import { describe, it, expect } from 'vitest';
import {
  isTokenValid,
  canonicalOrigin,
  hasScope,
  safeReturnPath,
  stateMatches,
  SpotifyReconnectRequired,
  type SpotifySession,
} from './spotifyAuth';

const tok = (over: Partial<SpotifySession> = {}): SpotifySession => ({
  accessToken: 'a',
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

describe('hasScope', () => {
  it('true when the granted scope string contains the scope', () => {
    expect(hasScope(tok({ scope: 'streaming playlist-read-private' }), 'playlist-read-private')).toBe(true);
  });

  it('false when the scope is missing from the grant', () => {
    expect(hasScope(tok({ scope: 'streaming user-read-email' }), 'playlist-read-private')).toBe(false);
  });

  it('false for legacy tokens with no recorded scope (forces re-auth)', () => {
    expect(hasScope(tok(), 'playlist-read-private')).toBe(false);
  });

  it('false for null token', () => {
    expect(hasScope(null, 'playlist-read-private')).toBe(false);
  });

  it('does not match substrings of other scopes', () => {
    expect(hasScope(tok({ scope: 'playlist-read-private' }), 'playlist-read-public')).toBe(false);
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
        hostname: 'cojam.example.com',
        port: '',
        origin: 'https://cojam.example.com',
      }),
    ).toBe('https://cojam.example.com');
  });
});

describe('SpotifyReconnectRequired (#252)', () => {
  it('is distinguishable from a transient error', () => {
    const err = new SpotifyReconnectRequired();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SpotifyReconnectRequired');
    expect(err.message).toMatch(/reconnect/i);
  });
});

describe('session shape (#252)', () => {
  // The whole point of moving custody server-side: nothing here holds a
  // long-lived credential.
  it('carries no refresh token', () => {
    expect(tok()).not.toHaveProperty('refreshToken');
    expect(tok({ scope: 'streaming' })).not.toHaveProperty('refreshToken');
  });
});

describe('safeReturnPath', () => {
  it('keeps same-origin absolute paths', () => {
    expect(safeReturnPath('/room/abc?x=1#h')).toBe('/room/abc?x=1#h');
    expect(safeReturnPath('/')).toBe('/');
  });

  it.each(['//evil.test', '//evil.test/x', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)', 'room/abc', '', '/a\nb'])(
    'rejects %j',
    (p) => {
      expect(safeReturnPath(p)).toBe('/');
    },
  );

  it('falls back for null and undefined', () => {
    expect(safeReturnPath(null)).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
  });
});

describe('stateMatches', () => {
  it('accepts only an identical, non-empty state', () => {
    expect(stateMatches('abc', 'abc')).toBe(true);
    expect(stateMatches('abc', 'abd')).toBe(false);
    expect(stateMatches('abc', null)).toBe(false);
    expect(stateMatches(null, 'abc')).toBe(false);
    expect(stateMatches('', '')).toBe(false);
  });
});
