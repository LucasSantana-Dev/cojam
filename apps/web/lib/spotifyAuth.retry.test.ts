// @vitest-environment-options {"url": "https://cojam.example.com/room/ABC"}
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./realtime', () => ({ resolveConnectionToken: vi.fn(async () => 'conn') }));

import { retryAuth } from './spotifyAuth';

describe('retryAuth', () => {
  beforeEach(() => {
    window.__COJAM_ENV__ = { spotifyClientId: 'test-client' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    delete window.__COJAM_ENV__;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('issues a fresh verifier and state and keeps the return path', async () => {
    sessionStorage.setItem('mj_spotify_verifier', 'old-verifier');
    sessionStorage.setItem('mj_spotify_state', 'old-state');
    sessionStorage.setItem('mj_spotify_return', '/room/ABC');

    await retryAuth();

    const verifier = sessionStorage.getItem('mj_spotify_verifier');
    const state = sessionStorage.getItem('mj_spotify_state');
    expect(verifier).toBeTruthy();
    expect(verifier).not.toBe('old-verifier');
    expect(state).toBeTruthy();
    expect(state).not.toBe('old-state');
    expect(sessionStorage.getItem('mj_spotify_return')).toBe('/room/ABC');
  });

  it('falls back to / when no return path was stored', async () => {
    sessionStorage.clear();
    await retryAuth();
    expect(sessionStorage.getItem('mj_spotify_return')).toBe('/');
  });
});
