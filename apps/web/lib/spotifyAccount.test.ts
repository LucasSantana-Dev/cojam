import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decidePlayable } from './spotifyAccount';

describe('decidePlayable', () => {
  beforeEach(() => {
    // Mock fetch globally
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when product is premium', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ product: 'premium' }),
    });
    const result = await decidePlayable('mock-token');
    expect(result).toBe(true);
  });

  it('returns false when product is free', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ product: 'free' }),
    });
    const result = await decidePlayable('mock-token');
    expect(result).toBe(false);
  });

  it('returns false when API call fails', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
    });
    const result = await decidePlayable('mock-token');
    expect(result).toBe(false);
  });

  it('returns false when token is null', async () => {
    const result = await decidePlayable(null);
    expect(result).toBe(false);
  });

  it('returns false when network error occurs', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));
    const result = await decidePlayable('mock-token');
    expect(result).toBe(false);
  });

  it('calls /v1/me with correct Authorization header', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ product: 'premium' }),
    });
    await decidePlayable('test-token-123');
    expect(global.fetch).toHaveBeenCalledWith('https://api.spotify.com/v1/me', {
      headers: { Authorization: 'Bearer test-token-123' },
    });
  });

  it('returns false when response is missing product field', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    const result = await decidePlayable('mock-token');
    expect(result).toBe(false);
  });
});
