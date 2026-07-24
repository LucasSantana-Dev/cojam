// Client-side Spotify track search with the user's own OAuth token. The server's
// aggregated search (match.SearchAll) queries Spotify with app client credentials,
// which this app (Spotify development mode, RFC-0007) gets 403s on, so server
// results are effectively Deezer-only and the `prefer` ranking has nothing
// Spotify-playable to promote. Searching here with the user token yields
// Spotify-playable results (URI included) that rank first when Spotify is a
// connected service. The token never leaves the client.

import { searchTracks, type SearchCandidate } from './realtime';
import { getAccessToken } from './spotifyAuth';

const SEARCH_URL = 'https://api.spotify.com/v1/search';
const SEARCH_LIMIT = 10;
// Matches the server's track.search result cap so the dropdown size is unchanged.
const RESULT_CAP = 8;

type SpotifySearchItem = {
  name?: string;
  uri?: string;
  duration_ms?: number;
  artists?: { name?: string }[];
  external_ids?: { isrc?: string };
  album?: { images?: { url?: string }[] };
};

// Maps one Spotify search item to a search candidate, or null for entries that
// can never resolve (removed tracks).
export function toSearchCandidate(item: SpotifySearchItem): SearchCandidate | null {
  if (!item?.name || !item?.uri) return null;
  return {
    title: item.name,
    artist: item.artists?.[0]?.name ?? '',
    source: 'spotify',
    spotifyUri: item.uri,
    isrc: item.external_ids?.isrc ?? '',
    durationMs: item.duration_ms ?? 0,
    artworkUrl: item.album?.images?.[0]?.url ?? '',
  };
}

// Searches /v1/search with the user's token. Fail-soft: the search UI degrades
// to server (Deezer fallback) results on any error, so this returns [] instead
// of throwing.
export async function searchSpotifyTracks(
  query: string,
  tokenProvider: () => Promise<string | null> = getAccessToken,
): Promise<SearchCandidate[]> {
  const token = await tokenProvider();
  if (!token) return [];
  const params = new URLSearchParams({ q: query, type: 'track', limit: String(SEARCH_LIMIT) });
  let res: Response;
  try {
    res = await fetch(`${SEARCH_URL}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as { tracks?: { items?: SpotifySearchItem[] } };
  const out: SearchCandidate[] = [];
  for (const item of data.tracks?.items ?? []) {
    const c = toSearchCandidate(item);
    if (c) out.push(c);
  }
  return out;
}

// Dedup keys: ISRC when present, always normalized title+artist. Both are needed:
// Deezer-sourced results carry no ISRC, so an ISRC-only key would never match a
// Spotify entry for the same track and the dropdown would show it twice.
function keys(c: SearchCandidate): string[] {
  const ks = [`title:${`${c.title}|${c.artist}`.toLowerCase()}`];
  if (c.isrc) ks.push(`isrc:${c.isrc}`);
  return ks;
}

// Merges client-side Spotify results with server results: connected-service
// results first, then server entries not already covered. On collision the
// first entry wins, which is the Spotify one (it carries the playable URI).
// Order within each group is preserved.
export function mergeSearchResults(
  spotify: SearchCandidate[],
  server: SearchCandidate[],
  cap = RESULT_CAP,
): SearchCandidate[] {
  const seen = new Set<string>();
  const merged: SearchCandidate[] = [];
  for (const c of [...spotify, ...server]) {
    const ks = keys(c);
    if (ks.some((k) => seen.has(k))) continue;
    for (const k of ks) seen.add(k);
    merged.push(c);
    if (merged.length >= cap) break;
  }
  return merged;
}

// Search entry point for the add-track form. When Spotify is a connected
// service (prefer contains 'spotify'), searches Spotify client-side with the
// user's token in parallel with the server search and merges: Spotify-playable
// results first, server (Deezer fallback) results after. Without a Spotify
// connection or token it is exactly the server search (which ranks by `prefer`
// on its own). Apple has no client-side search; those users get server results.
// `tokenProvider` defaults to the stored OAuth token and is injectable for tests.
export async function searchAllTracks(
  query: string,
  prefer: string[],
  tokenProvider?: () => Promise<string | null>,
): Promise<SearchCandidate[]> {
  if (!prefer.includes('spotify')) {
    return searchTracks(query, prefer);
  }
  const [spotify, server] = await Promise.all([searchSpotifyTracks(query, tokenProvider), searchTracks(query, prefer)]);
  return mergeSearchResults(spotify, server);
}
