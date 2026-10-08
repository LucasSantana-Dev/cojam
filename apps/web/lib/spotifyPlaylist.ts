// RFC-0007: client-side Spotify playlist import. The app's client-credentials
// token gets 403 on /v1/playlists/* calls (development mode), so the browser
// fetches the playlist with the user's own OAuth token and hands resolved track
// metadata to the server. Since the Feb 2026 API change, /playlists/{id}/tracks
// is gone (use /items, whose entries carry `item`, formerly `track`) and a
// development-mode app only gets contents of playlists the user owns or
// collaborates on.

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

type PlaylistTrack = {
    name?: string;
    uri?: string;
    duration_ms?: number;
    artists?: { name?: string }[];
    external_ids?: { isrc?: string };
    album?: { images?: { url?: string }[] };
};

type PlaylistItem = {
  item?: PlaylistTrack | null;
  track?: PlaylistTrack | null;
};

// Maps one Spotify playlist item to a track ref, or null for entries that can
// never resolve (local files, removed tracks).
export function toTrackRef(item: PlaylistItem): ImportTrack | null {
  const t = item?.item ?? item?.track;
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
    throw new SpotifyImportError('Conecte o Spotify para importar playlists do Spotify.');
  }

  const tracks: ImportTrack[] = [];
  let next: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100&market=from_token` +
    '&fields=items(item(name,uri,duration_ms,artists(name),external_ids,album(images)),' +
    'track(name,uri,duration_ms,artists(name),external_ids,album(images))),next';

  while (next && tracks.length < MAX_IMPORT_TRACKS) {
    const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) {
      throw new SpotifyImportError(
        'O Spotify só deixa importar playlists que são suas ou em que você colabora. ' +
          'Copie as músicas para uma playlist sua e cole o link dela, ou use uma playlist do Deezer ou do YouTube.',
      );
    }
    if (res.status === 404 || playlistId.startsWith('37i9')) {
      throw new SpotifyImportError(
        'Playlists criadas pelo próprio Spotify (como as Daily Mix e as do Spotify) não podem ser importadas. ' +
          'Copie as músicas para uma playlist sua e cole o link dela.',
      );
    }
    if (res.status === 429) {
      throw new SpotifyImportError('O Spotify limitou as requisições. Tente de novo em um minuto.');
    }
    if (!res.ok) {
      throw new SpotifyImportError(`A importação do Spotify falhou (status ${res.status}).`);
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
    throw new SpotifyImportError('Essa playlist não tem músicas que dê para importar.');
  }
  return tracks;
}
