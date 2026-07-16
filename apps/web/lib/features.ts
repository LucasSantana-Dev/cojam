// Feature toggles. Every platform integration is gated here so it can be turned
// on/off per environment without code changes. Add a flag before adding a feature.

export type Features = {
  youtube: boolean;
  spotify: boolean;
  apple: boolean;
  presence: boolean;
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
  };
}

// Next.js statically inlines each NEXT_PUBLIC_* key, so reference them literally.
export const features: Features = resolveFeatures({
  NEXT_PUBLIC_FEATURE_YOUTUBE: process.env.NEXT_PUBLIC_FEATURE_YOUTUBE,
  NEXT_PUBLIC_FEATURE_SPOTIFY: process.env.NEXT_PUBLIC_FEATURE_SPOTIFY,
  NEXT_PUBLIC_FEATURE_APPLE: process.env.NEXT_PUBLIC_FEATURE_APPLE,
  NEXT_PUBLIC_FEATURE_PRESENCE: process.env.NEXT_PUBLIC_FEATURE_PRESENCE,
});
