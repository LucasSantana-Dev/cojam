// Runtime client config, served as JavaScript. Rendered per-request (never
// statically cached) so the same built image can be pointed at any deployment by
// setting COJAM_WS_URL / COJAM_SPOTIFY_CLIENT_ID in the server environment.
// Loaded via a beforeInteractive <Script> so window.__COJAM_ENV__ is set before
// the app runs. See lib/runtimeEnv.ts.
export const dynamic = 'force-dynamic';

export function GET() {
  const env: {
    wsUrl: string;
    spotifyClientId: string;
    spotifyEnabled?: boolean;
    supabaseUrl?: string;
    supabaseAnonKey?: string;
  } = {
    wsUrl: process.env.COJAM_WS_URL ?? '',
    spotifyClientId: process.env.COJAM_SPOTIFY_CLIENT_ID ?? '',
  };
  // Accounts are optional: only emit when both are set, so an unset runtime
  // value falls back to the build-time NEXT_PUBLIC_* pair.
  if (process.env.COJAM_SUPABASE_URL !== undefined) {
    env.supabaseUrl = process.env.COJAM_SUPABASE_URL;
  }
  if (process.env.COJAM_SUPABASE_ANON_KEY !== undefined) {
    env.supabaseAnonKey = process.env.COJAM_SUPABASE_ANON_KEY;
  }
  // Feature flags must be runtime-configurable too: NEXT_PUBLIC_* are inlined at
  // build time, so the env-agnostic image cannot enable Spotify without this.
  // Only emit when explicitly set, so an UNSET runtime value falls back to the
  // build-time flag (`?? features.spotify`) instead of forcing it off.
  if (process.env.COJAM_FEATURE_SPOTIFY !== undefined) {
    env.spotifyEnabled = process.env.COJAM_FEATURE_SPOTIFY === 'true';
  }
  // JSON.stringify keeps the values safely encoded inside the script.
  const body = `window.__COJAM_ENV__ = ${JSON.stringify(env)};`;
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
