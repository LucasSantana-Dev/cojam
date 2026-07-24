// RFC-0007: client-side Spotify playlist import. The app's client-credentials
// token gets 403 on all /v1/playlists/* calls (development mode, post 2024-11
// Spotify API changes), so the browser fetches the playlist with the user's own
// OAuth token and hands resolved track metadata to the server. The token never
// leaves the client.

import type { TrackRef } from '@cojam/shared';
import { getAccessToken } from './spotifyAuth';

// Mirrors the server's maxImportTracks: keeps the RPC frame under centrifuge's
// 64 KiB default message limit.
export const MAX_IMPORT_TRACKS = 200;

export class SpotifyImportError extends Error {}

export type ImportTrack = Omit<TrackRef, 'id' | 'addedBy'>;

// Extracts the playlist id from open.spotify.com URLs or spotify: URIs.
export function parseSpotifyPlaylistId(url: string): string | null {
  const m = url.trim().match(/(?:open\.spotify\.com\/playlist\/|spotify:playlist:)([0-9A-Za-z]{22})/);
  return m ? m[1] : null;
}

type PlaylistItem = {
  track?: {
    name?: string;
    uri?: string;
    duration_ms?: number;
    artists?: { name?: string }[];
    external_ids?: { isrc?: string };
    album?: { images?: { url?: string }[] };
  } | null;
};

// Maps one Spotify playlist item to a track ref, or null for entries that can
// never resolve (local files, removed tracks).
export function toTrackRef(item: PlaylistItem): ImportTrack | null {
  const t = item?.track;
  if (!t?.name || !t?.uri) return null;
  return {
    title: t.name,
    artist: t.artists?.[0]?.name ?? '',
    durationMs: t.duration_ms,
    isrc: t.external_ids?.isrc,
    artworkUrl: t.album?.images?.[0]?.url,
    sources: { spotify: { trackUri: t.uri, confidence: 1 } },
  };
}

// Pages through /v1/playlists/{id}/tracks with the user's token, capped at
// MAX_IMPORT_TRACKS. `tokenProvider` defaults to the stored OAuth token and is
// injectable for tests.
export async function fetchSpotifyPlaylistTracks(
  playlistId: string,
  tokenProvider: () => Promise<string | null> = getAccessToken,
): Promise<ImportTrack[]> {
  const token = await tokenProvider();
  if (!token) {
    throw new SpotifyImportError('Connect Spotify to import Spotify playlists.');
  }

  const tracks: ImportTrack[] = [];
  let next: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100` +
    '&fields=items(track(name,uri,duration_ms,artists(name),external_ids,album(images))),next';

  while (next && tracks.length < MAX_IMPORT_TRACKS) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) {
      throw new SpotifyImportError(
        'Spotify blocks playlist reads for this app (development mode). Import a Deezer playlist instead.',
      );
    }
    if (res.status === 404) {
      throw new SpotifyImportError('Playlist not found. If it is private, reconnect Spotify to grant access.');
    }
    if (res.status === 429) {
      throw new SpotifyImportError('Spotify rate-limited the import; try again in a minute.');
    }
    if (!res.ok) {
      throw new SpotifyImportError(`Spotify import failed (status ${res.status}).`);
    }
    const data = (await res.json()) as { items?: PlaylistItem[]; next?: string | null };
    for (const item of data.items ?? []) {
      const ref = toTrackRef(item);
      if (ref) tracks.push(ref);
      if (tracks.length >= MAX_IMPORT_TRACKS) break;
    }
    next = data.next ?? null;
  }

  if (tracks.length === 0) {
    throw new SpotifyImportError('That playlist has no importable tracks.');
  }
  return tracks;
}
