// Spotify OAuth 2.0 Authorization Code + PKCE for a SPA (no client secret).
// Web Playback SDK needs the `streaming` scope + a Premium account.

export type StoredToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
};

const STORAGE_KEY = 'mj_spotify_token';
const VERIFIER_KEY = 'mj_spotify_verifier';
const RETURN_KEY = 'mj_spotify_return';
const REFRESH_SKEW_MS = 60_000; // refresh a minute early
const SCOPES = 'streaming user-read-email user-read-private';
const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// Pure: is this token usable right now? (exported for unit tests)
export function isTokenValid(t: StoredToken | null, now: number): boolean {
  return !!t && t.expiresAt - REFRESH_SKEW_MS > now;
}

function clientId(): string {
  const id = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID;
  if (!id) throw new Error('NEXT_PUBLIC_SPOTIFY_CLIENT_ID not set');
  return id;
}

// Spotify banned `localhost` redirect URIs (April 2025) — only the loopback IP
// `127.0.0.1` is accepted. In local dev the app is usually opened at
// `localhost:3000`, so window.location.origin would build a redirect_uri Spotify
// rejects ("redirect_uri: Not matching configuration"). Return the origin Spotify
// accepts: swap a `localhost` hostname for `127.0.0.1`, keeping protocol + port.
// Production hosts (e.g. https://cojam.fly.dev) pass through untouched.
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

function loadStored(): StoredToken | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
}

function store(t: StoredToken) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(t));
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
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: clientId(),
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = await res.json();
  store({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  sessionStorage.removeItem(VERIFIER_KEY);
  return sessionStorage.getItem(RETURN_KEY) ?? '/';
}

async function refresh(t: StoredToken): Promise<StoredToken | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refreshToken,
    client_id: clientId(),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return null;
  const data = await res.json();
  const next: StoredToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? t.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  store(next);
  return next;
}

// Returns a valid access token, refreshing if needed, or null if not authed.
export async function getAccessToken(): Promise<string | null> {
  const t = loadStored();
  if (isTokenValid(t, Date.now())) return t!.accessToken;
  if (t?.refreshToken) {
    const refreshed = await refresh(t);
    if (refreshed) return refreshed.accessToken;
  }
  return null;
}

export function isAuthed(): boolean {
  return isTokenValid(loadStored(), Date.now());
}
