// Supabase client for accounts. Optional by design: when no project URL/key is
// configured (env unset), getSupabase() returns null and every account feature
// hides itself, leaving guest behavior exactly as before.
//
// Config resolution follows the runtime-env pattern (see lib/runtimeEnv.ts):
// COJAM_SUPABASE_URL / COJAM_SUPABASE_ANON_KEY injected via /env.js at request
// time win over build-time NEXT_PUBLIC_* so one image fits any deployment.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { pickEnv, getRuntimeEnv } from './runtimeEnv';

let client: SupabaseClient | null | undefined; // undefined = not yet resolved

export function supabaseConfig(): { url: string; anonKey: string } {
  const runtime = getRuntimeEnv();
  return {
    url: pickEnv(runtime?.supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_URL),
    anonKey: pickEnv(runtime?.supabaseAnonKey, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
}

export function supabaseEnabled(): boolean {
  const { url, anonKey } = supabaseConfig();
  return url !== '' && anonKey !== '';
}

// getSupabase returns the singleton client, or null when Supabase is not
// configured or when called during SSR (the client persists auth in storage).
export function getSupabase(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  if (client !== undefined) return client;
  if (!supabaseEnabled()) {
    client = null;
    return client;
  }
  const { url, anonKey } = supabaseConfig();
  client = createClient(url, anonKey);
  return client;
}

// Test hook: reset the memoized client between tests.
export function __resetSupabaseForTests(): void {
  client = undefined;
}
