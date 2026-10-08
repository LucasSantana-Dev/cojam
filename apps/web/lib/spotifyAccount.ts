// Spotify account tier detection for Premium gate.

export type AccountCheck = 'premium' | 'free' | 'forbidden' | 'unauthorized' | 'error';

/**
 * Probe /v1/me and say why an account is or is not playable, so the room can
 * tell a free account from an allowlist rejection (403, Development Mode app)
 * or an expired token (401).
 */
export async function checkAccount(token: string | null): Promise<AccountCheck> {
  if (!token) return 'unauthorized';
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) return 'forbidden';
    if (res.status === 401) return 'unauthorized';
    if (!res.ok) return 'error';
    const data = await res.json();
    return data.product === 'premium' ? 'premium' : 'free';
  } catch {
    return 'error';
  }
}

/**
 * Check if a Spotify account is Premium by fetching /v1/me and examining product.
 * Returns true only if the response indicates 'premium'; treats errors and free tier as false.
 * Safe default: on any error (network, invalid token, API failure), returns false
 * so the adapter won't stream and pickSource will degrade to YouTube.
 */
export async function decidePlayable(token: string | null): Promise<boolean> {
  return (await checkAccount(token)) === 'premium';
}
