// Spotify OAuth 2.0 Authorization Code + PKCE, with the code-for-token exchange
// on our server (#252). Web Playback SDK needs the `streaming` scope + Premium.
//
// The refresh token never reaches this file. It is held server-side, keyed to
// the connauth anonymous sub, and only a short-lived access token comes back.
// PKCE protects the authorization code in transit; it does nothing for the
// tokens that code produces, which is why the old sessionStorage copy was a
// standing risk.

import { pickEnv, getRuntimeEnv } from './runtimeEnv';
import { resolveConnectionToken } from './realtime';
import { trackError } from './telemetry';

export type SpotifySession = {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope?: string; // granted scopes from the token response
};
const VERIFIER_KEY = 'mj_spotify_verifier';
const RETURN_KEY = 'mj_spotify_return';
const REFRESH_SKEW_MS = 60_000; // refresh a minute early
// playlist-read-private enables RFC-0007 client-side playlist import. Verified
// empirically (2026-07-20): this app gets `invalid_scope` when requesting
// `playlist-read-public`, while `playlist-read-private` is accepted and user
// tokens read public playlists without a dedicated scope. Refreshing an
// old-scope token does NOT grant new scopes: users must re-consent once.
const SCOPES = 'streaming user-read-email user-read-private playlist-read-private';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
// Our server, not Spotify's token endpoint: the client secret and the refresh
// token both live there (#252).
const EXCHANGE_URL = '/api/spotify/token';
const REFRESH_URL = '/api/spotify/refresh';

// Raised when the server has no usable refresh token for this identity, which
// the caller must surface as "reconnect Spotify" rather than a transient error.
export class SpotifyReconnectRequired extends Error {
  constructor() {
    super('Spotify session expired. Reconnect to keep playing.');
    this.name = 'SpotifyReconnectRequired';
  }
}

// Pure: is this token usable right now? (exported for unit tests)
export function isTokenValid(t: SpotifySession | null, now: number): boolean {
  return !!t && t.expiresAt - REFRESH_SKEW_MS > now;
}

// Pure: was `scope` part of this token's grant? Legacy tokens have no recorded
// scope, so they fail the check and trigger a re-auth (exported for unit tests).
export function hasScope(t: SpotifySession | null, scope: string): boolean {
  if (!t?.scope) return false;
  return t.scope.split(' ').includes(scope);
}

function clientId(): string {
  const id = pickEnv(getRuntimeEnv()?.spotifyClientId, process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID);
  if (!id) throw new Error('Spotify client id not set (COJAM_SPOTIFY_CLIENT_ID or NEXT_PUBLIC_SPOTIFY_CLIENT_ID)');
  return id;
}

// Spotify banned `localhost` redirect URIs (April 2025) — only the loopback IP
// `127.0.0.1` is accepted. In local dev the app is usually opened at
// `localhost:3000`, so window.location.origin would build a redirect_uri Spotify
// rejects ("redirect_uri: Not matching configuration"). Return the origin Spotify
// accepts: swap a `localhost` hostname for `127.0.0.1`, keeping protocol + port.
// Production hosts (e.g. https://cojam.example.com) pass through untouched.
export function canonicalOrigin(loc: {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
}): string {
  if (loc.hostname === 'localhost') {
    return `${loc.protocol}//127.0.0.1${loc.port ? `:${loc.port}` : ''}`;
  }
  return loc.origin;
}

function redirectUri(): string {
  return `${canonicalOrigin(window.location)}/callback/spotify`;
}

// In memory only, deliberately. A reload costs one /api/spotify/refresh
// round-trip, which is the right trade for keeping the token out of any
// storage a script can read.
let session: SpotifySession | null = null;

// Set when the server reports the grant is unrecoverable; see
// needsSpotifyReconnect below.
let reconnectRequired = false;

function loadStored(): SpotifySession | null {
  return session;
}

function store(t: SpotifySession | null) {
  session = t;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(64));
  const verifier = base64url(random);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// Redirect to Spotify's consent screen. `returnPath` is where we come back to.
export async function beginAuth(returnPath: string): Promise<void> {
  // Run the whole OAuth flow on the Spotify-registered origin. On localhost we
  // relocate to 127.0.0.1 first: the verifier stored below is origin-scoped and
  // must live on the same origin the /callback/spotify page will read it from.
  const canonical = canonicalOrigin(window.location);
  if (canonical !== window.location.origin) {
    window.location.assign(`${canonical}${window.location.pathname}${window.location.search}`);
    return;
  }
  const { verifier, challenge } = await pkce();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(RETURN_KEY, returnPath);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  window.location.assign(`${AUTH_URL}?${params}`);
}

// Called on the /callback/spotify page. Returns the path to navigate back to.
export async function handleCallback(code: string): Promise<string> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('missing PKCE verifier');

  // The connection JWT identifies which record the refresh token is filed
  // under. Without it the server cannot key the grant to anyone.
  const connToken = await resolveConnectionToken();
  if (!connToken) throw new Error('Could not get a session token from the server. Try again in a moment.');

  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      redirectUri: redirectUri(),
      connToken,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);

  const data = await res.json();
  store({
    accessToken: data.accessToken,
    expiresAt: Date.now() + data.expiresIn * 1000,
    scope: data.scope,
  });
  reconnectRequired = false;
  sessionStorage.removeItem(VERIFIER_KEY);
  return sessionStorage.getItem(RETURN_KEY) ?? '/';
}

// Asks the server to mint a fresh access token from the refresh token it holds.
// Returns null on a transient failure, and throws SpotifyReconnectRequired when
// the grant is gone for good (revoked, or nothing stored).
async function refresh(): Promise<SpotifySession | null> {
  const connToken = await resolveConnectionToken();
  if (!connToken) return null;

  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connToken }),
  });

  // 404 is the server saying it has nothing usable: the user revoked the grant
  // in Spotify, or the record expired. Retrying can never succeed.
  if (res.status === 404) {
    store(null);
    throw new SpotifyReconnectRequired();
  }
  if (!res.ok) return null;

  const data = await res.json();
  const next: SpotifySession = {
    accessToken: data.accessToken,
    expiresAt: Date.now() + data.expiresIn * 1000,
    // Refresh responses may omit scope; the grant does not change on refresh.
    scope: data.scope ?? session?.scope,
  };
  store(next);
  return next;
}

// Returns a valid access token, refreshing if needed, or null if not authed.
export async function getAccessToken(): Promise<string | null> {
  const t = loadStored();
  if (isTokenValid(t, Date.now())) return t!.accessToken;

  // No in-memory session is the normal state after a reload, not a signal that
  // the user is unauthenticated: the server may still hold their grant.
  //
  // This stays total. Thirteen call sites treat null as "not connected", and
  // making them handle an exception would be a wide change for a condition
  // they cannot act on individually. A permanent failure is recorded on the
  // module instead, for the UI to surface once.
  try {
    const refreshed = await refresh();
    return refreshed?.accessToken ?? null;
  } catch (err) {
    if (err instanceof SpotifyReconnectRequired) {
      reconnectRequired = true;
      trackError('token_refresh_failed', err);
      return null;
    }
    return null;
  }
}

// True once the server has told us the grant is gone for good. The UI reads
// this to offer a reconnect instead of leaving a connected-looking session
// that silently cannot play — the failure mode #176 fixed for playback.
export function needsSpotifyReconnect(): boolean {
  return reconnectRequired;
}

// Cleared when a fresh connect succeeds.
export function clearSpotifyReconnect(): void {
  reconnectRequired = false;
}

export function isAuthed(): boolean {
  return isTokenValid(loadStored(), Date.now());
}

// Can the stored token read playlists (RFC-0007 import)? False for legacy
// tokens granted before the playlist-read scope existed: those users must
// re-connect Spotify once. Public playlists are readable by any user token;
// the scope additionally covers private ones.
export function canReadPlaylists(): boolean {
  return hasScope(loadStored(), 'playlist-read-private');
}
