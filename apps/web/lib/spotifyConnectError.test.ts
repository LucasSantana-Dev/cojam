import { describe, it, expect } from 'vitest';
import {
  SpotifyConnectError,
  canRetrySpotifyConnect,
  kindFromAccountCheck,
  kindFromAuthorizeError,
  kindFromError,
  kindFromExchangeStatus,
  spotifyConnectMessage,
  type SpotifyConnectErrorKind,
} from './spotifyConnectError';

describe('kindFromExchangeStatus', () => {
  it.each([
    [401, 'session'],
    [429, 'rateLimited'],
    [400, 'server'],
    [403, 'unknown'],
    [502, 'rejected'],
    [404, 'server'],
    [500, 'server'],
    [501, 'server'],
    [503, 'server'],
    [418, 'unknown'],
  ])('status %i -> %s', (status, kind) => {
    expect(kindFromExchangeStatus(status)).toBe(kind);
  });
});

describe('kindFromAuthorizeError', () => {
  it('maps access_denied to denied', () => {
    expect(kindFromAuthorizeError('access_denied')).toBe('denied');
  });
  it.each(['invalid_scope', 'unauthorized_client', 'invalid_client', 'invalid_request'])(
    'maps %s to rejected',
    (err) => {
      expect(kindFromAuthorizeError(err)).toBe('rejected');
    },
  );
  it.each(['server_error', 'temporarily_unavailable', 'weird_new_code'])('maps %s to unknown (retryable)', (err) => {
    expect(kindFromAuthorizeError(err)).toBe('unknown');
  });
  it('returns null when there is no error param', () => {
    expect(kindFromAuthorizeError(null)).toBeNull();
  });
});

describe('kindFromAccountCheck', () => {
  it.each([
    ['premium', null],
    ['free', 'premium'],
    ['forbidden', 'rejected'],
    ['unauthorized', 'reconnect'],
    ['error', 'unknown'],
  ] as const)('%s -> %s', (check, kind) => {
    expect(kindFromAccountCheck(check)).toBe(kind);
  });
});

describe('spotifyConnectMessage', () => {
  const kinds: SpotifyConnectErrorKind[] = [
    'denied', 'rejected', 'server', 'rateLimited', 'session',
    'network', 'expired', 'sdk', 'premium', 'reconnect', 'unknown',
  ];
  it('has a non-empty PT-BR message for every kind, with no dashes', () => {
    for (const k of kinds) {
      const m = spotifyConnectMessage(k);
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toMatch(/[–—]/);
    }
  });
  it('uses the agreed copy for the headline cases', () => {
    expect(spotifyConnectMessage('denied')).toBe('Você cancelou a autorização no Spotify.');
    expect(spotifyConnectMessage('rejected')).toContain('lista de testadores');
    expect(spotifyConnectMessage('server')).toContain('erro do servidor');
    expect(spotifyConnectMessage('premium')).toContain('A sala continua tocando pelo YouTube.');
  });
});

describe('canRetrySpotifyConnect', () => {
  it('is false only for premium and sdk', () => {
    expect(canRetrySpotifyConnect('premium')).toBe(false);
    expect(canRetrySpotifyConnect('sdk')).toBe(false);
    expect(canRetrySpotifyConnect('server')).toBe(true);
    expect(canRetrySpotifyConnect('denied')).toBe(true);
  });
});

describe('kindFromError', () => {
  it('reads the kind off a SpotifyConnectError', () => {
    expect(kindFromError(new SpotifyConnectError('network'))).toBe('network');
  });
  it('falls back to unknown for anything else', () => {
    expect(kindFromError(new Error('boom'))).toBe('unknown');
    expect(kindFromError('x')).toBe('unknown');
  });
  it('never puts detail beyond the kind in the error message', () => {
    expect(new SpotifyConnectError('rejected').message).toBe('spotify connect failed: rejected');
  });
});
