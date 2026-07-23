// Runtime configuration for the web client.
//
// Next.js inlines NEXT_PUBLIC_* at BUILD time, which would bake a single host's
// values into the image. Instead the server emits `/env.js` at request time,
// setting window.__COJAM_ENV__, so one image can be pointed at any deployment by
// setting COJAM_WS_URL / COJAM_SPOTIFY_CLIENT_ID at runtime. Build-time
// NEXT_PUBLIC_* remain a fallback for local dev and static hosting.

import type { Features, FeatureName } from './features';

export type RuntimeEnv = {
  wsUrl?: string;
  spotifyClientId?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  // Runtime feature-flag overrides emitted by /env.js from COJAM_FEATURE_*.
  // Only flags whose env var is explicitly set appear here; absent keys fall
  // back to the build-time flag.
  features?: Partial<Record<FeatureName, boolean>>;
};

// resolveRuntimeFeatures merges the runtime /env.js feature map over the
// build-time defaults: a key present in the runtime map wins, an absent key
// keeps the build-time value.
export function resolveRuntimeFeatures(
  build: Features,
  runtime: Partial<Record<FeatureName, boolean>> | undefined,
): Features {
  return { ...build, ...runtime };
}

// pickEnv resolves a value: runtime injection first, then a build-time value,
// then a default. Blank/whitespace-only values are treated as unset.
export function pickEnv(
  runtime: string | undefined,
  buildTime: string | undefined,
  fallback = '',
): string {
  if (runtime && runtime.trim()) return runtime;
  if (buildTime && buildTime.trim()) return buildTime;
  return fallback;
}

// getRuntimeEnv reads the server-injected config; undefined on the server or
// before /env.js has run.
export function getRuntimeEnv(): RuntimeEnv | undefined {
  return typeof window !== 'undefined' ? window.__COJAM_ENV__ : undefined;
}

declare global {
  interface Window {
    __COJAM_ENV__?: RuntimeEnv;
  }
}
