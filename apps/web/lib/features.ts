// Feature toggles. Every platform integration is gated here so it can be turned
// on/off per environment without code changes. Add a flag before adding a feature.

export type Features = {
  youtube: boolean;
  spotify: boolean;
  presence: boolean;
  trackDepth: boolean;
  lyrics: boolean;
  listenBrainz: boolean;
  lastfmEnrich: boolean;
  sync: boolean;
  roomAuth: boolean;
  queueVoting: boolean;
  roomChat: boolean;
  publicRooms: boolean;
  telemetry: boolean;
  // Video co-watch (E1, #258). Its own flag, NOT sync: video carries the ToS
  // exposure accepted in ADR-0007 and must switch off without disabling audio
  // drift correction.
  video: boolean;
  // Screen share (#310, ADR-0008): private rooms only, off until the ECA legal
  // review (#259, question 10) clears it. Needs roomAuth on the server.
  screenShare: boolean;
};

export type FeatureName = keyof Features;

// Runtime counterparts of the NEXT_PUBLIC_FEATURE_* keys below: /env.js reads
// these COJAM_FEATURE_* vars per request and emits a `features` map, so one
// image can flip any flag at deploy time without a rebuild (RFC-0006).
export const FEATURE_ENV_VARS: Record<FeatureName, string> = {
  youtube: 'COJAM_FEATURE_YOUTUBE',
  spotify: 'COJAM_FEATURE_SPOTIFY',
  presence: 'COJAM_FEATURE_PRESENCE',
  trackDepth: 'COJAM_FEATURE_TRACK_DEPTH',
  lyrics: 'COJAM_FEATURE_LYRICS',
  listenBrainz: 'COJAM_FEATURE_LISTENBRAINZ',
  lastfmEnrich: 'COJAM_FEATURE_LASTFM_ENRICH',
  sync: 'COJAM_FEATURE_SYNC',
  roomAuth: 'COJAM_FEATURE_ROOM_AUTH',
  queueVoting: 'COJAM_FEATURE_QUEUE_VOTING',
  roomChat: 'COJAM_FEATURE_ROOM_CHAT',
  publicRooms: 'COJAM_FEATURE_PUBLIC_ROOMS',
  telemetry: 'COJAM_FEATURE_TELEMETRY',
  video: 'COJAM_FEATURE_VIDEO',
  screenShare: 'COJAM_FEATURE_SCREENSHARE',
};

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

// parseFlag reads one toggle value: 1/true/on/yes → true, 0/false/off/no →
// false (case-insensitive), unset or unrecognized → undefined so the caller
// applies its own default. Mirrors featureEnabledIn in the Go server.
export function parseFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return undefined;
}

// Pure + testable: env map → resolved flags with per-flag defaults.
export function resolveFeatures(env: Record<string, string | undefined>): Features {
  const flag = (raw: string | undefined, dflt: boolean): boolean => parseFlag(raw) ?? dflt;
  return {
    youtube: flag(env.NEXT_PUBLIC_FEATURE_YOUTUBE, true),
    spotify: flag(env.NEXT_PUBLIC_FEATURE_SPOTIFY, false),
    presence: flag(env.NEXT_PUBLIC_FEATURE_PRESENCE, true),
    trackDepth: flag(env.NEXT_PUBLIC_FEATURE_TRACK_DEPTH, true),
    lyrics: flag(env.NEXT_PUBLIC_FEATURE_LYRICS, true),
    listenBrainz: flag(env.NEXT_PUBLIC_FEATURE_LISTENBRAINZ, false),
    lastfmEnrich: flag(env.NEXT_PUBLIC_FEATURE_LASTFM_ENRICH, false),
    sync: flag(env.NEXT_PUBLIC_FEATURE_SYNC, false),
    roomAuth: flag(env.NEXT_PUBLIC_FEATURE_ROOM_AUTH, false),
    queueVoting: flag(env.NEXT_PUBLIC_FEATURE_QUEUE_VOTING, false),
    roomChat: flag(env.NEXT_PUBLIC_FEATURE_ROOM_CHAT, false),
    publicRooms: flag(env.NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS, false),
    telemetry: flag(env.NEXT_PUBLIC_FEATURE_TELEMETRY, false),
    video: flag(env.NEXT_PUBLIC_FEATURE_VIDEO, false),
    screenShare: flag(env.NEXT_PUBLIC_FEATURE_SCREENSHARE, false),
  };
}

// Next.js statically inlines each NEXT_PUBLIC_* key, so reference them literally.
export const features: Features = resolveFeatures({
  NEXT_PUBLIC_FEATURE_YOUTUBE: process.env.NEXT_PUBLIC_FEATURE_YOUTUBE,
  NEXT_PUBLIC_FEATURE_SPOTIFY: process.env.NEXT_PUBLIC_FEATURE_SPOTIFY,
  NEXT_PUBLIC_FEATURE_PRESENCE: process.env.NEXT_PUBLIC_FEATURE_PRESENCE,
  NEXT_PUBLIC_FEATURE_TRACK_DEPTH: process.env.NEXT_PUBLIC_FEATURE_TRACK_DEPTH,
  NEXT_PUBLIC_FEATURE_LYRICS: process.env.NEXT_PUBLIC_FEATURE_LYRICS,
  NEXT_PUBLIC_FEATURE_LISTENBRAINZ: process.env.NEXT_PUBLIC_FEATURE_LISTENBRAINZ,
  NEXT_PUBLIC_FEATURE_LASTFM_ENRICH: process.env.NEXT_PUBLIC_FEATURE_LASTFM_ENRICH,
  NEXT_PUBLIC_FEATURE_SYNC: process.env.NEXT_PUBLIC_FEATURE_SYNC,
  NEXT_PUBLIC_FEATURE_ROOM_AUTH: process.env.NEXT_PUBLIC_FEATURE_ROOM_AUTH,
  NEXT_PUBLIC_FEATURE_QUEUE_VOTING: process.env.NEXT_PUBLIC_FEATURE_QUEUE_VOTING,
  NEXT_PUBLIC_FEATURE_ROOM_CHAT: process.env.NEXT_PUBLIC_FEATURE_ROOM_CHAT,
  NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS: process.env.NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS,
  NEXT_PUBLIC_FEATURE_TELEMETRY: process.env.NEXT_PUBLIC_FEATURE_TELEMETRY,
  NEXT_PUBLIC_FEATURE_VIDEO: process.env.NEXT_PUBLIC_FEATURE_VIDEO,
  NEXT_PUBLIC_FEATURE_SCREENSHARE: process.env.NEXT_PUBLIC_FEATURE_SCREENSHARE,
});
