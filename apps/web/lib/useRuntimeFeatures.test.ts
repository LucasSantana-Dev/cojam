import { describe, it, expect, afterEach } from 'vitest';
import { features } from './features';
import { resolveClientFeatures } from './useRuntimeFeatures';

// The hook itself is a one-line useSyncExternalStore wiring; the behavior worth
// pinning lives in its client snapshot (build-time fallback, runtime merge, and
// the stable identity useSyncExternalStore requires), tested here without a DOM.
describe('resolveClientFeatures (useRuntimeFeatures client snapshot)', () => {
  function setRuntimeEnv(env: Record<string, unknown> | undefined) {
    const g = globalThis as { window?: { __COJAM_ENV__?: unknown } };
    if (env === undefined) delete g.window;
    else g.window = { __COJAM_ENV__: env };
  }

  afterEach(() => {
    setRuntimeEnv(undefined);
  });

  it('falls back to the build-time map when /env.js injected no features', () => {
    setRuntimeEnv({});
    expect(resolveClientFeatures()).toEqual(features);
  });

  it('falls back to the build-time map with no window at all (server)', () => {
    setRuntimeEnv(undefined);
    expect(resolveClientFeatures()).toEqual(features);
  });

  it('merges the runtime features map over the build-time defaults', () => {
    setRuntimeEnv({ features: { spotify: true, youtube: false } });
    const f = resolveClientFeatures();
    expect(f.spotify).toBe(true);
    expect(f.youtube).toBe(false);
    expect(f.presence).toBe(features.presence);
  });

  it('returns a stable object across calls (useSyncExternalStore snapshot)', () => {
    setRuntimeEnv({ features: { sync: true } });
    expect(resolveClientFeatures()).toBe(resolveClientFeatures());
  });

  it('re-resolves when the injected features object changes', () => {
    setRuntimeEnv({ features: { sync: true } });
    expect(resolveClientFeatures().sync).toBe(true);
    setRuntimeEnv({ features: { sync: false } });
    expect(resolveClientFeatures().sync).toBe(false);
  });
});
