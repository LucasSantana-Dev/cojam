import { describe, it, expect } from 'vitest';
import { resolveFeatures } from './features';

describe('resolveFeatures', () => {
  it('youtube+presence default on, spotify/apple/listenbrainz/sync default off', () => {
    const f = resolveFeatures({});
    expect(f).toEqual({
      youtube: true,
      spotify: false,
      apple: false,
      presence: true,
      trackDepth: true,
      lyrics: true,
      listenBrainz: false,
      sync: false,
    });
  });

  it('reads truthy values case-insensitively', () => {
    const f = resolveFeatures({
      NEXT_PUBLIC_FEATURE_SPOTIFY: 'TRUE',
      NEXT_PUBLIC_FEATURE_APPLE: '1',
      NEXT_PUBLIC_FEATURE_YOUTUBE: 'off',
      NEXT_PUBLIC_FEATURE_PRESENCE: 'no',
      NEXT_PUBLIC_FEATURE_LISTENBRAINZ: 'true',
      NEXT_PUBLIC_FEATURE_SYNC: 'yes',
    });
    expect(f).toEqual({
      youtube: false,
      spotify: true,
      apple: true,
      presence: false,
      trackDepth: true,
      lyrics: true,
      listenBrainz: true,
      sync: true,
    });
  });

  it('unknown value falls back to the flag default', () => {
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SPOTIFY: 'maybe' }).spotify).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_YOUTUBE: 'maybe' }).youtube).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SYNC: 'maybe' }).sync).toBe(false);
  });

  it('trackDepth defaults on and can be disabled', () => {
    expect(resolveFeatures({}).trackDepth).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_TRACK_DEPTH: 'off' }).trackDepth).toBe(false);
  });

  it('lyrics defaults on and can be disabled', () => {
    expect(resolveFeatures({}).lyrics).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LYRICS: 'off' }).lyrics).toBe(false);
  });

  it('sync defaults off and can be enabled', () => {
    expect(resolveFeatures({}).sync).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_SYNC: 'on' }).sync).toBe(true);
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

  it('listenbrainz defaults off and can be enabled', () => {
    expect(resolveFeatures({}).listenBrainz).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LISTENBRAINZ: 'on' }).listenBrainz).toBe(true);
  });

});
