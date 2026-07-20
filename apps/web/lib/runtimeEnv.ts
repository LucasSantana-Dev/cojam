// Runtime configuration for the web client.
//
// Next.js inlines NEXT_PUBLIC_* at BUILD time, which would bake a single host's
// values into the image. Instead the server emits `/env.js` at request time,
// setting window.__COJAM_ENV__, so one image can be pointed at any deployment by
// setting COJAM_WS_URL / COJAM_SPOTIFY_CLIENT_ID at runtime. Build-time
// NEXT_PUBLIC_* remain a fallback for local dev and static hosting.

export type RuntimeEnv = {
  wsUrl?: string;
  spotifyClientId?: string;
  spotifyEnabled?: boolean;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

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
