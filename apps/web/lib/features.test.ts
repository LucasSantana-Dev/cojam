import { describe, it, expect } from 'vitest';
import { resolveFeatures, FEATURE_ENV_VARS } from './features';

describe('resolveFeatures', () => {
  it('youtube+presence default on, spotify/apple/listenbrainz/lastfmEnrich/sync default off', () => {
    const f = resolveFeatures({});
    expect(f).toEqual({
      youtube: true,
      spotify: false,
      apple: false,
      presence: true,
      trackDepth: true,
      lyrics: true,
      listenBrainz: false,
      lastfmEnrich: false,
      sync: false,
      roomAuth: false,
      queueVoting: false,
      roomChat: false,
      publicRooms: false,
    });
  });

  it('reads truthy values case-insensitively', () => {
    const f = resolveFeatures({
      NEXT_PUBLIC_FEATURE_SPOTIFY: 'TRUE',
      NEXT_PUBLIC_FEATURE_APPLE: '1',
      NEXT_PUBLIC_FEATURE_YOUTUBE: 'off',
      NEXT_PUBLIC_FEATURE_PRESENCE: 'no',
      NEXT_PUBLIC_FEATURE_LISTENBRAINZ: 'true',
      NEXT_PUBLIC_FEATURE_LASTFM_ENRICH: 'on',
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
      lastfmEnrich: true,
      sync: true,
      roomAuth: false,
      queueVoting: false,
      roomChat: false,
      publicRooms: false,
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

  it('queueVoting defaults off and can be enabled', () => {
    expect(resolveFeatures({}).queueVoting).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_QUEUE_VOTING: 'on' }).queueVoting).toBe(true);
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

  it('lastfmenrich defaults off and can be enabled', () => {
    expect(resolveFeatures({}).lastfmEnrich).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_LASTFM_ENRICH: 'on' }).lastfmEnrich).toBe(true);
  });

  it('roomChat defaults off and can be enabled', () => {
    expect(resolveFeatures({}).roomChat).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_ROOM_CHAT: 'on' }).roomChat).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_ROOM_CHAT: 'maybe' }).roomChat).toBe(false);
  });

  it('publicRooms defaults off and can be enabled', () => {
    expect(resolveFeatures({}).publicRooms).toBe(false);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS: 'on' }).publicRooms).toBe(true);
    expect(resolveFeatures({ NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS: 'maybe' }).publicRooms).toBe(false);
  });

});

describe('FEATURE_ENV_VARS', () => {
  it('covers every flag with a COJAM_FEATURE_* runtime counterpart', () => {
    expect(Object.keys(FEATURE_ENV_VARS).sort()).toEqual(Object.keys(resolveFeatures({})).sort());
    for (const envVar of Object.values(FEATURE_ENV_VARS)) {
      expect(envVar).toMatch(/^COJAM_FEATURE_/);
    }
  });
});
