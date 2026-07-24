import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseSpotifyPlaylistId,
  toTrackRef,
  fetchSpotifyPlaylistTracks,
  SpotifyImportError,
  MAX_IMPORT_TRACKS,
} from './spotifyPlaylist';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseSpotifyPlaylistId', () => {
  it('parses open.spotify.com URLs', () => {
    expect(parseSpotifyPlaylistId('https://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM')).toBe('0vvXsWCC9xrXsKd4FyS8kM');
  });

  it('parses URLs with query params', () => {
    expect(parseSpotifyPlaylistId('https://open.spotify.com/playlist/0vvXsWCC9xrXsKd4FyS8kM?si=abc123')).toBe('0vvXsWCC9xrXsKd4FyS8kM');
  });

  it('parses spotify: URIs', () => {
    expect(parseSpotifyPlaylistId('spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM')).toBe('0vvXsWCC9xrXsKd4FyS8kM');
  });

  it('rejects non-playlist Spotify URLs', () => {
    expect(parseSpotifyPlaylistId('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')).toBeNull();
  });

  it('rejects non-Spotify URLs', () => {
    expect(parseSpotifyPlaylistId('https://www.deezer.com/en/playlist/123456')).toBeNull();
  });
});

describe('toTrackRef', () => {
  it('maps a playlist item to a track ref with spotify source', () => {
    const ref = toTrackRef({
      track: {
        name: 'Song',
        uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
        duration_ms: 200000,
        artists: [{ name: 'Artist' }],
        external_ids: { isrc: 'XX0000000001' },
      },
    });
    expect(ref).toEqual({
      title: 'Song',
      artist: 'Artist',
      durationMs: 200000,
      isrc: 'XX0000000001',
      sources: { spotify: { trackUri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', confidence: 1 } },
    });
  });

  it('returns null for items without name or uri (local files, removed tracks)', () => {
    expect(toTrackRef({ track: null })).toBeNull();
    expect(toTrackRef({ track: { name: '', uri: 'spotify:track:x' } })).toBeNull();
  });

  it('handles missing artists and external_ids', () => {
    const ref = toTrackRef({ track: { name: 'S', uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', duration_ms: 1 } });
    expect(ref?.artist).toBe('');
    expect(ref?.isrc).toBeUndefined();
  });

  it('maps album art to artworkUrl for the queue thumb', () => {
    const ref = toTrackRef({
      track: {
        name: 'S',
        uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
        album: { images: [{ url: 'https://i.scdn.co/image/large' }, { url: 'https://i.scdn.co/image/small' }] },
      },
    });
    expect(ref?.artworkUrl).toBe('https://i.scdn.co/image/large');
  });
});

describe('fetchSpotifyPlaylistTracks', () => {
  const item = (n: number) => ({
    track: {
      name: `T${n}`,
      uri: `spotify:track:4uLU6hMCjMI75M1A2tKUQ${String(n).padStart(2, '0')}`.slice(0, 36),
      duration_ms: 1000,
      artists: [{ name: 'A' }],
      external_ids: {},
    },
  });

  it('pages until next is null', async () => {
    const page1 =
      'https://api.spotify.com/v1/playlists/p/tracks?limit=100' +
      '&fields=items(track(name,uri,duration_ms,artists(name),external_ids,album(images))),next';
    const pages: Record<string, object> = {
      [page1]: {
        items: [item(1)],
        next: 'https://api.spotify.com/v1/playlists/p/tracks?offset=100&limit=100',
      },
      'https://api.spotify.com/v1/playlists/p/tracks?offset=100&limit=100': {
        items: [item(2)],
        next: null,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => pages[url],
    })));

    const tracks = await fetchSpotifyPlaylistTracks('p', async () => 'tok');
    expect(tracks).toHaveLength(2);
    expect(tracks[0].title).toBe('T1');
    expect(tracks[1].title).toBe('T2');
  });

  it('throws a development-mode restriction error on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    await expect(fetchSpotifyPlaylistTracks('p', async () => 'tok')).rejects.toThrow(/development mode/i);
  });

  it('throws a rate-limit error on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    await expect(fetchSpotifyPlaylistTracks('p', async () => 'tok')).rejects.toThrow(/rate/i);
  });

  it('throws when there is no token', async () => {
    await expect(fetchSpotifyPlaylistTracks('p', async () => null)).rejects.toThrow(SpotifyImportError);
  });

  it('throws on an empty playlist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next: null }) })));
    await expect(fetchSpotifyPlaylistTracks('p', async () => 'tok')).rejects.toThrow(/no importable tracks/i);
  });

  it('truncates at MAX_IMPORT_TRACKS (payload budget)', async () => {
    const many = Array.from({ length: 100 }, (_, i) => item(i));
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ items: many, next: `page-${calls}` }) };
    }));
    const tracks = await fetchSpotifyPlaylistTracks('p', async () => 'tok');
    expect(tracks).toHaveLength(MAX_IMPORT_TRACKS);
  });
});
