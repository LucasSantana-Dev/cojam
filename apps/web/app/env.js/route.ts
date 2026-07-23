// Runtime client config, served as JavaScript. Rendered per-request (never
// statically cached) so the same built image can be pointed at any deployment by
// setting COJAM_WS_URL / COJAM_SPOTIFY_CLIENT_ID in the server environment.
// Loaded via a beforeInteractive <Script> so window.__COJAM_ENV__ is set before
// the app runs. See lib/runtimeEnv.ts.
import { FEATURE_ENV_VARS, type FeatureName } from '@/lib/features';

export const dynamic = 'force-dynamic';

export function GET() {
  const env: {
    wsUrl: string;
    spotifyClientId: string;
    supabaseUrl?: string;
    supabaseAnonKey?: string;
    features?: Partial<Record<FeatureName, boolean>>;
  } = {
    wsUrl: process.env.COJAM_WS_URL ?? '',
    spotifyClientId: process.env.COJAM_SPOTIFY_CLIENT_ID ?? '',
  };
  // Accounts are optional: the Supabase pair is emitted only when BOTH runtime
  // values are set. Emitting just one would mix the runtime project with the
  // build-time NEXT_PUBLIC_* fallback of the other, pointing the client at two
  // different Supabase projects.
  if (process.env.COJAM_SUPABASE_URL !== undefined && process.env.COJAM_SUPABASE_ANON_KEY !== undefined) {
    env.supabaseUrl = process.env.COJAM_SUPABASE_URL;
    env.supabaseAnonKey = process.env.COJAM_SUPABASE_ANON_KEY;
  }
  // Feature flags must be runtime-configurable too: NEXT_PUBLIC_* are inlined at
  // build time, so the env-agnostic image cannot flip a flag without these. Each
  // flag is emitted only when its COJAM_FEATURE_* var is explicitly set, so an
  // UNSET runtime value falls back to the build-time flag instead of forcing it
  // off. The map itself is omitted when no flag is set.
  const features: Partial<Record<FeatureName, boolean>> = {};
  for (const [name, envVar] of Object.entries(FEATURE_ENV_VARS) as [FeatureName, string][]) {
    const raw = process.env[envVar];
    if (raw !== undefined) features[name] = raw === 'true';
  }
  if (Object.keys(features).length > 0) env.features = features;
  // JSON.stringify keeps the values safely encoded inside the script.
  const body = `window.__COJAM_ENV__ = ${JSON.stringify(env)};`;
  return new Response(body, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
