import { describe, it, expect } from 'vitest';
import { resolveFeatures } from './features';

describe('resolveFeatures', () => {
  it('youtube defaults on, spotify/apple default off (need setup)', () => {
    const f = resolveFeatures({});
    expect(f).toEqual({ youtube: true, spotify: false, apple: false });
  });

  it('reads truthy values case-insensitively', () => {
    const f = resolveFeatures({
      NEXT_PUBLIC_FEATURE_SPOTIFY: 'TRUE',
      NEXT_PUBLIC_FEATURE_APPLE: '1',
      NEXT_PUBLIC_FEATURE_YOUTUBE: 'off',
    });
    expect(f).toEqual({ youtube: false, spotify: true, apple: true });
  });

  it('unknown value falls back to the flag default', () => {
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SPOTIFY: 'maybe' }).spotify).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_YOUTUBE: 'maybe' }).youtube).toBe(true);
  });

  it('accepts on/yes as enabled', () => {
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SPOTIFY: 'on' }).spotify).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_APPLE: 'yes' }).apple).toBe(true);
  });
});
