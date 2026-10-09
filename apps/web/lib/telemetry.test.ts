import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trackSyncDrift, detectPlatform, trackEvent, trackError } from './telemetry';

type Beacon = { url: string; body: Record<string, unknown> };

async function readBeacons(calls: unknown[][]): Promise<Beacon[]> {
  return Promise.all(
    calls.map(async ([url, blob]) => ({ url: url as string, body: JSON.parse(await (blob as Blob).text()) })),
  );
}

describe('client telemetry', () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    window.__COJAM_ENV__ = { features: { telemetry: true } };
  });

  afterEach(() => {
    delete window.__COJAM_ENV__;
    vi.restoreAllMocks();
  });

  it('sends exactly the sync_drift schema, with no ids or urls', async () => {
    trackSyncDrift({ driftMs: -1234.6, player: 'youtube', canSeek: true, hidden: false, rttMs: 41.7 });
    const [{ url, body }] = await readBeacons(beacon.mock.calls);
    expect(url).toBe('/api/telemetry');
    expect(Object.keys(body).sort()).toEqual(['canSeek', 'driftMs', 'hidden', 'name', 'platform', 'player', 'rttMs', 'type']);
    expect(body).toMatchObject({ type: 'sample', name: 'sync_drift', driftMs: -1235, player: 'youtube', canSeek: true, hidden: false, rttMs: 42 });
    expect(['mobile', 'desktop']).toContain(body.platform);
    expect(JSON.stringify(body)).not.toMatch(/room|track|http|user/i);
  });

  it('clamps drift to +/-600000 ms', async () => {
    trackSyncDrift({ driftMs: 9_999_999, player: 'spotify', canSeek: false, hidden: true, rttMs: 0 });
    trackSyncDrift({ driftMs: -9_999_999, player: 'spotify', canSeek: false, hidden: true, rttMs: 0 });
    const beacons = await readBeacons(beacon.mock.calls);
    expect(beacons.map((b) => b.body.driftMs)).toEqual([600_000, -600_000]);
  });

  it('sends nothing when the telemetry flag is off', () => {
    window.__COJAM_ENV__ = { features: { telemetry: false } };
    trackSyncDrift({ driftMs: 5, player: 'youtube', canSeek: true, hidden: false, rttMs: 1 });
    trackEvent('track_added');
    expect(beacon).not.toHaveBeenCalled();
  });

  it('emits the four never-sent names with the shapes the server allowlist expects', async () => {
    trackEvent('track_added');
    trackEvent('provider_connected');
    trackError('ws_terminal', new Error('disconnect code 3000'));
    trackError('playback_failed', new Error('youtube error 150'));
    const beacons = await readBeacons(beacon.mock.calls);
    expect(beacons.map((b) => [b.body.type, b.body.name])).toEqual([
      ['event', 'track_added'],
      ['event', 'provider_connected'],
      ['error', 'ws_terminal'],
      ['error', 'playback_failed'],
    ]);
  });
});

describe('detectPlatform', () => {
  const setMatch = (coarse: boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({ matches: coarse && q.includes('coarse') })) as typeof window.matchMedia);
  const setUA = (ua: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);

  afterEach(() => vi.restoreAllMocks());

  it('treats a coarse pointer as mobile', () => {
    setMatch(true);
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(detectPlatform()).toBe('mobile');
  });

  it('falls back to the UA when the pointer is fine', () => {
    setMatch(false);
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148');
    expect(detectPlatform()).toBe('mobile');
    setUA('Mozilla/5.0 (X11; Linux x86_64) Chrome/120');
    expect(detectPlatform()).toBe('desktop');
  });
});
