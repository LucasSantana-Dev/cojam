// Spotify account tier detection for Premium gate.

/**
 * Check if a Spotify account is Premium by fetching /v1/me and examining product.
 * Returns true only if the response indicates 'premium'; treats errors and free tier as false.
 * Safe default: on any error (network, invalid token, API failure), returns false
 * so the adapter won't stream and pickSource will degrade to YouTube.
 */
export async function decidePlayable(token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.product === 'premium';
  } catch {
    return false;
  }
}
