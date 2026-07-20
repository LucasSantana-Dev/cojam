// Account layer: Supabase Auth session + profile + remembered connected services.
// Everything here is a no-op (null/empty) when Supabase is not configured or the
// user is not signed in; guests never touch this module's network paths.
//
// Spotify/Apple OAuth tokens stay client-side (lib/spotifyAuth.ts, MusicKit);
// only the fact of the connection is persisted, never credentials.

import { getSupabase } from './supabase';

export type AccountSession = {
  userId: string;
  email: string | null;
  accessToken: string;
};

// getAccountSession returns the current signed-in session, or null.
export async function getAccountSession(): Promise<AccountSession | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.auth.getSession();
  if (error || !data.session) return null;
  return {
    userId: data.session.user.id,
    email: data.session.user.email ?? null,
    accessToken: data.session.access_token,
  };
}

// getAccountToken returns the access token for the centrifuge connection
// (the server validates it and derives the stable "sb:<uuid>" identity), or
// null when signed out: the caller then falls back to anonymous room auth.
export async function getAccountToken(): Promise<string | null> {
  const session = await getAccountSession();
  return session?.accessToken ?? null;
}

// signInWithEmail sends a magic link. The link lands on /account, where the
// session is picked up from the URL by the Supabase client.
export async function signInWithEmail(email: string): Promise<{ error: string | null }> {
  const sb = getSupabase();
  if (!sb) return { error: 'Accounts are not configured' };
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/account` },
  });
  return { error: error?.message ?? null };
}

// signInWithGoogle starts the OAuth flow: the browser navigates to Google and
// returns to /account, where the Supabase client completes the code exchange.
// Requires the Google provider enabled in the Supabase dashboard (OAuth client
// id/secret); the issued session is a standard Supabase JWT, so the server side
// needs nothing Google-specific.
export async function signInWithGoogle(): Promise<{ error: string | null }> {
  const sb = getSupabase();
  if (!sb) return { error: 'Accounts are not configured' };
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/account` },
  });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb.auth.signOut();
}

// --- Profile ---

export async function getDisplayName(): Promise<string | null> {
  const sb = getSupabase();
  const session = await getAccountSession();
  if (!sb || !session) return null;
  const { data, error } = await sb
    .from('profiles')
    .select('display_name')
    .eq('id', session.userId)
    .maybeSingle();
  if (error) return null;
  return (data?.display_name as string | null) ?? null;
}

export async function saveDisplayName(displayName: string): Promise<{ error: string | null }> {
  const sb = getSupabase();
  const session = await getAccountSession();
  if (!sb || !session) return { error: 'Not signed in' };
  const { error } = await sb
    .from('profiles')
    .upsert({ id: session.userId, display_name: displayName, updated_at: new Date().toISOString() });
  return { error: error?.message ?? null };
}

// --- Connected services (fact of connection only, no tokens) ---

export type ConnectedProvider = 'spotify' | 'apple';

export async function getConnectedServices(): Promise<ConnectedProvider[]> {
  const sb = getSupabase();
  const session = await getAccountSession();
  if (!sb || !session) return [];
  const { data, error } = await sb
    .from('connected_services')
    .select('provider')
    .eq('user_id', session.userId);
  if (error || !data) return [];
  return data
    .map((row) => row.provider as string)
    .filter((p): p is ConnectedProvider => p === 'spotify' || p === 'apple');
}

export async function markServiceConnected(provider: ConnectedProvider): Promise<void> {
  const sb = getSupabase();
  const session = await getAccountSession();
  if (!sb || !session) return;
  await sb
    .from('connected_services')
    .upsert({ user_id: session.userId, provider });
}

export async function markServiceDisconnected(provider: ConnectedProvider): Promise<void> {
  const sb = getSupabase();
  const session = await getAccountSession();
  if (!sb || !session) return;
  await sb
    .from('connected_services')
    .delete()
    .eq('user_id', session.userId)
    .eq('provider', provider);
}

// mergeProviderPrefs unions persisted connected services with live auth state so
// search ranking is right even before local OAuth state settles (fresh browser,
// expired sessionStorage) and on any device. Canonical order matches
// buildProviderPrefs: spotify before apple. Unknown persisted values are dropped.
export function mergeProviderPrefs(
  persisted: string[],
  live: { spotify?: boolean; apple?: boolean },
): string[] {
  const has = (p: ConnectedProvider) => persisted.includes(p) || live[p] === true;
  const prefs: string[] = [];
  if (has('spotify')) prefs.push('spotify');
  if (has('apple')) prefs.push('apple');
  return prefs;
}
