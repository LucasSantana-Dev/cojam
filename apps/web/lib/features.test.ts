import { describe, it, expect } from 'vitest';
import { resolveFeatures } from './features';

describe('resolveFeatures', () => {
  it('youtube+presence default on, spotify/apple default off (need setup)', () => {
    const f = resolveFeatures({});
    expect(f).toEqual({ youtube: true, spotify: false, apple: false, presence: true, trackDepth: true, lyrics: true, transport: true });
  });

  it('reads truthy values case-insensitively', () => {
    const f = resolveFeatures({
      NEXT_PUBLIC_FEATURE_SPOTIFY: 'TRUE',
      NEXT_PUBLIC_FEATURE_APPLE: '1',
      NEXT_PUBLIC_FEATURE_YOUTUBE: 'off',
      NEXT_PUBLIC_FEATURE_PRESENCE: 'no',
    });
    expect(f).toEqual({ youtube: false, spotify: true, apple: true, presence: false, trackDepth: true, lyrics: true, transport: true });
  });

  it('unknown value falls back to the flag default', () => {
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SPOTIFY: 'maybe' }).spotify).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_YOUTUBE: 'maybe' }).youtube).toBe(true);
  });

  it('trackDepth defaults on and can be disabled', () => {
    expect(resolveFeatures({}).trackDepth).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_TRACK_DEPTH: 'off' }).trackDepth).toBe(false);
  });

  it('lyrics defaults on and can be disabled', () => {
    expect(resolveFeatures({}).lyrics).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LYRICS: 'off' }).lyrics).toBe(false);
  });

  it('accepts on/yes as enabled', () => {
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SPOTIFY: 'on' }).spotify).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_APPLE: 'yes' }).apple).toBe(true);
  });

  it('lyrics flag accepts truthy values', () => {
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LYRICS: '1' }).lyrics).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LYRICS: 'true' }).lyrics).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LYRICS: 'on' }).lyrics).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LYRICS: 'yes' }).lyrics).toBe(true);
  });
});
