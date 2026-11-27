import { describe, it, expect, vi } from 'vitest';
import { createOverrideSource, parseOverrides, serverBase } from './flagOverrides';

describe('serverBase', () => {
  it('prefers COJAM_SERVER_URL, then SERVER_ORIGIN, then the ws origin', () => {
    expect(serverBase({ COJAM_SERVER_URL: 'http://cojam-server:8080/', SERVER_ORIGIN: 'http://x' })).toBe(
      'http://cojam-server:8080',
    );
    expect(serverBase({ SERVER_ORIGIN: 'http://localhost:8080' })).toBe('http://localhost:8080');
    expect(serverBase({ COJAM_WS_URL: 'wss://cojam.example/connection/websocket' })).toBe('https://cojam.example');
    expect(serverBase({ COJAM_WS_URL: 'ws://localhost:8080' })).toBe('http://localhost:8080');
  });

  it('is empty when nothing names the server', () => {
    expect(serverBase({})).toBe('');
    expect(serverBase({ COJAM_WS_URL: 'not a url' })).toBe('');
    expect(serverBase({ COJAM_WS_URL: 'https://wrong.scheme' })).toBe('');
  });
});

describe('parseOverrides', () => {
  it('keeps only known flags with boolean values', () => {
    expect(
      parseOverrides({ features: { sync: true, screenShare: false, ghost: true, video: 'yes', __proto__: true } }),
    ).toEqual({ sync: true, screenShare: false });
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides({ features: 'x' })).toEqual({});
  });
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

describe('createOverrideSource', () => {
  it('caches for the TTL and keeps the last good map on failure', async () => {
    let t = 0;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ features: { roomChat: true } }))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(jsonResponse({}, false));
    const read = createOverrideSource({ base: () => 'http://s', fetchFn, now: () => t, ttlMs: 100 });

    expect(await read()).toEqual({ roomChat: true });
    expect(fetchFn).toHaveBeenCalledWith('http://s/api/features', expect.anything());
    t = 50;
    expect(await read()).toEqual({ roomChat: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 200;
    expect(await read()).toEqual({ roomChat: true }); // failed read keeps the last map
    t = 400;
    expect(await read()).toEqual({ roomChat: true }); // non-2xx too
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('never fetches without a server base', async () => {
    const fetchFn = vi.fn();
    const read = createOverrideSource({ base: () => '', fetchFn });
    expect(await read()).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
