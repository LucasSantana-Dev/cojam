// Connection authentication: fetch a signed JWT for centrifuge connection.
// This implements RFC-0005 U2: client-side token fetching and persistence.

import { pickEnv, getRuntimeEnv } from './runtimeEnv';

const STORAGE_KEY = 'cojam_uid';
const TOKEN_STORAGE_KEY = 'cojam_token';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    // Use window.localStorage which is properly mocked in tests
    return (typeof window !== 'undefined' && window.localStorage) || (global as any).localStorage;
  } catch {
    return null;
  }
}

// Get the stored anonymous user ID from localStorage, or null if not set.
// Safe for SSR: returns null if window is undefined.
export function getStoredUserId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const storage = getStorage();
    return storage ? storage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

// Get the previous connection token, presented to /api/connection-token as
// proof of identity ownership when asking to keep the stored user ID.
function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const storage = getStorage();
    return storage ? storage.getItem(TOKEN_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

// Store the anonymous user ID and its connection token in localStorage.
// Safe for SSR: no-op if window is undefined.
function storeIdentity(userId: string, token: string): void {
  if (typeof window === 'undefined') return;
  try {
    const storage = getStorage();
    if (storage) {
      storage.setItem(STORAGE_KEY, userId);
      storage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // localStorage may be unavailable (private browsing, etc.); silent fail
  }
}

// Derive the HTTP base URL from the wsUrl (e.g. ws://localhost:8080 -> http://localhost:8080).
// If no wsUrl, fall back to window.location.origin.
function getHttpBase(): string {
  const wsUrl = pickEnv(
    getRuntimeEnv()?.wsUrl,
    process.env.NEXT_PUBLIC_WS_URL,
    '',
  );

  if (wsUrl) {
    // Parse ws:// or wss:// and convert to http:// or https://
    const url = new URL(wsUrl);
    const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${url.host}`;
  }

  // Fallback to the current origin
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // SSR or no env: return a default (will likely fail at fetch time, but safe)
  return 'http://localhost:8080';
}

export type ConnectionTokenResult = {
  token: string;
  userId: string;
};

// Fetch a signed JWT for the centrifuge connection.
// If a userId is stored, include it as ?userId=<id> plus the previous token as
// ?token=<proof> so the server can verify ownership before reissuing the
// identity (without proof it mints a fresh one; spoofing is rejected silently).
// Returns {token, userId} on success; null if feature is off (501), network error, or any other error.
// Does NOT throw: failures are logged implicitly and return null for the caller to fall back.
export async function fetchConnectionToken(baseUrl?: string): Promise<ConnectionTokenResult | null> {
  try {
    // Use provided baseUrl or derive it
    const url = new URL(baseUrl || getHttpBase());
    url.pathname = '/api/connection-token';

    // Include stored identity + ownership proof if available
    const storedUid = getStoredUserId();
    if (storedUid) {
      url.searchParams.set('userId', storedUid);
      const storedToken = getStoredToken();
      if (storedToken) {
        url.searchParams.set('token', storedToken);
      }
    }

    const res = await fetch(url.toString());

    // 501 means feature is off; return null (caller falls back to v0 behavior)
    if (res.status === 501) {
      return null;
    }

    // Other errors: also return null (network, 404, 500, etc.)
    if (!res.ok) {
      return null;
    }

    const data = await res.json() as { token: string; userId: string };

    // Persist the returned identity for the next reconnect/refresh
    storeIdentity(data.userId, data.token);

    return { token: data.token, userId: data.userId };
  } catch {
    // Network error, JSON parse error, or other exception: return null
    return null;
  }
}
