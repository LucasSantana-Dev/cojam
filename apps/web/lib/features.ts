// Feature toggles. Every platform integration is gated here so it can be turned
// on/off per environment without code changes. Add a flag before adding a feature.

export type Features = {
  youtube: boolean;
  spotify: boolean;
  apple: boolean;
  presence: boolean;
  trackDepth: boolean;
  lyrics: boolean;
  listenBrainz: boolean;
  lastfmEnrich: boolean;
  sync: boolean;
  roomAuth: boolean;
};

export type FeatureName = keyof Features;

// Runtime counterparts of the NEXT_PUBLIC_FEATURE_* keys below: /env.js reads
// these COJAM_FEATURE_* vars per request and emits a `features` map, so one
// image can flip any flag at deploy time without a rebuild (RFC-0006).
export const FEATURE_ENV_VARS: Record<FeatureName, string> = {
  youtube: 'COJAM_FEATURE_YOUTUBE',
  spotify: 'COJAM_FEATURE_SPOTIFY',
  apple: 'COJAM_FEATURE_APPLE',
  presence: 'COJAM_FEATURE_PRESENCE',
  trackDepth: 'COJAM_FEATURE_TRACK_DEPTH',
  lyrics: 'COJAM_FEATURE_LYRICS',
  listenBrainz: 'COJAM_FEATURE_LISTENBRAINZ',
  lastfmEnrich: 'COJAM_FEATURE_LASTFM_ENRICH',
  sync: 'COJAM_FEATURE_SYNC',
  roomAuth: 'COJAM_FEATURE_ROOM_AUTH',
};

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

// Pure + testable: env map → resolved flags with per-flag defaults.
export function resolveFeatures(env: Record<string, string | undefined>): Features {
  const flag = (raw: string | undefined, dflt: boolean): boolean => {
    if (raw === undefined) return dflt;
    const v = raw.toLowerCase();
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    return dflt; // unrecognized → default
  };
  return {
    youtube: flag(env.NEXT_PUBLIC_FEATURE_YOUTUBE, true),
    spotify: flag(env.NEXT_PUBLIC_FEATURE_SPOTIFY, false),
    apple: flag(env.NEXT_PUBLIC_FEATURE_APPLE, false),
    presence: flag(env.NEXT_PUBLIC_FEATURE_PRESENCE, true),
    trackDepth: flag(env.NEXT_PUBLIC_FEATURE_TRACK_DEPTH, true),
    lyrics: flag(env.NEXT_PUBLIC_FEATURE_LYRICS, true),
    listenBrainz: flag(env.NEXT_PUBLIC_FEATURE_LISTENBRAINZ, false),
    lastfmEnrich: flag(env.NEXT_PUBLIC_FEATURE_LASTFM_ENRICH, false),
    sync: flag(env.NEXT_PUBLIC_FEATURE_SYNC, false),
    roomAuth: flag(env.NEXT_PUBLIC_FEATURE_ROOM_AUTH, false),
  };
}

// Next.js statically inlines each NEXT_PUBLIC_* key, so reference them literally.
export const features: Features = resolveFeatures({
  NEXT_PUBLIC_FEATURE_YOUTUBE: process.env.NEXT_PUBLIC_FEATURE_YOUTUBE,
  NEXT_PUBLIC_FEATURE_SPOTIFY: process.env.NEXT_PUBLIC_FEATURE_SPOTIFY,
  NEXT_PUBLIC_FEATURE_APPLE: process.env.NEXT_PUBLIC_FEATURE_APPLE,
  NEXT_PUBLIC_FEATURE_PRESENCE: process.env.NEXT_PUBLIC_FEATURE_PRESENCE,
  NEXT_PUBLIC_FEATURE_TRACK_DEPTH: process.env.NEXT_PUBLIC_FEATURE_TRACK_DEPTH,
  NEXT_PUBLIC_FEATURE_LYRICS: process.env.NEXT_PUBLIC_FEATURE_LYRICS,
  NEXT_PUBLIC_FEATURE_LISTENBRAINZ: process.env.NEXT_PUBLIC_FEATURE_LISTENBRAINZ,
  NEXT_PUBLIC_FEATURE_LASTFM_ENRICH: process.env.NEXT_PUBLIC_FEATURE_LASTFM_ENRICH,
  NEXT_PUBLIC_FEATURE_SYNC: process.env.NEXT_PUBLIC_FEATURE_SYNC,
  NEXT_PUBLIC_FEATURE_ROOM_AUTH: process.env.NEXT_PUBLIC_FEATURE_ROOM_AUTH,
});
