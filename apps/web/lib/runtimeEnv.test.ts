import { describe, it, expect } from 'vitest';
import { pickEnv } from './runtimeEnv';

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
