import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./realtime', () => ({
  resolveConnectionToken: vi.fn(async () => 'conn'),
}));

import { handleCallback } from './spotifyAuth';
import { resolveConnectionToken } from './realtime';

function seed(state: string | null = 's1', verifier: string | null = 'v1') {
  sessionStorage.clear();
  if (state) sessionStorage.setItem('mj_spotify_state', state);
  if (verifier) sessionStorage.setItem('mj_spotify_verifier', verifier);
  sessionStorage.setItem('mj_spotify_return', '/room/ABC');
}

async function kindOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { kind?: string }).kind;
  }
  return 'resolved';
}

describe('handleCallback failure mapping', () => {
  beforeEach(() => {
    vi.mocked(resolveConnectionToken).mockResolvedValue('conn');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags a state mismatch as expired', async () => {
    seed('s1');
    expect(await kindOf(handleCallback('c', 'other'))).toBe('expired');
  });

  it('flags a missing state as expired', async () => {
    seed(null);
    expect(await kindOf(handleCallback('c', 's1'))).toBe('expired');
  });

  it('flags a missing PKCE verifier as expired', async () => {
    seed('s1', null);
    expect(await kindOf(handleCallback('c', 's1'))).toBe('expired');
  });

  it('flags a missing connection token as session', async () => {
    seed();
    vi.mocked(resolveConnectionToken).mockResolvedValue('');
    expect(await kindOf(handleCallback('c', 's1'))).toBe('session');
  });

  it.each([
    [404, 'server'],
    [500, 'server'],
    [502, 'rejected'],
    [429, 'rateLimited'],
    [401, 'session'],
  ])('maps exchange status %i to %s', async (status, kind) => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status }) as Response));
    expect(await kindOf(handleCallback('c', 's1'))).toBe(kind);
  });

  it('maps a network failure to network', async () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    expect(await kindOf(handleCallback('c', 's1'))).toBe('network');
  });

  it('returns the stored path on success', async () => {
    seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accessToken: 'a', expiresIn: 3600 }) }) as Response),
    );
    expect(await handleCallback('c', 's1')).toBe('/room/ABC');
  });
});
