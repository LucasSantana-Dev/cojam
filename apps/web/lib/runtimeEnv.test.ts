import { describe, it, expect } from 'vitest';
import { resolveFeatures } from './features';
import { pickEnv, resolveRuntimeFeatures } from './runtimeEnv';

describe('pickEnv', () => {
  it('prefers the runtime value when present', () => {
    expect(pickEnv('wss://runtime/ws', 'wss://build/ws', 'ws://default')).toBe('wss://runtime/ws');
  });

  it('falls back to the build-time value when runtime is unset', () => {
    expect(pickEnv(undefined, 'wss://build/ws', 'ws://default')).toBe('wss://build/ws');
  });

  it('treats blank/whitespace runtime as unset', () => {
    expect(pickEnv('   ', 'wss://build/ws', 'ws://default')).toBe('wss://build/ws');
  });

  it('falls back to the default when both are unset', () => {
    expect(pickEnv(undefined, undefined, 'ws://default')).toBe('ws://default');
  });

  it('returns empty string when nothing is set and no default given', () => {
    expect(pickEnv(undefined, undefined)).toBe('');
  });
});

describe('resolveRuntimeFeatures', () => {
  const build = resolveFeatures({});

  it('returns the build-time map when no runtime map is injected', () => {
    expect(resolveRuntimeFeatures(build, undefined)).toEqual(build);
  });

  it('runtime values override build-time values, on and off', () => {
    const f = resolveRuntimeFeatures(build, { spotify: true, youtube: false });
    expect(f.spotify).toBe(true);
    expect(f.youtube).toBe(false);
  });

  it('flags absent from the runtime map keep their build-time value', () => {
    expect(resolveRuntimeFeatures(build, { spotify: true })).toEqual({ ...build, spotify: true });
  });
});
