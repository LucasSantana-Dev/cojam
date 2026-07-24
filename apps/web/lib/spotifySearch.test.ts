import { describe, it, expect, vi, afterEach } from 'vitest';
import { toSearchCandidate, searchSpotifyTracks, mergeSearchResults, searchAllTracks } from './spotifySearch';
import { searchTracks, type SearchCandidate } from './realtime';

vi.mock('./realtime', () => ({
  searchTracks: vi.fn(),
}));

const searchTracksMock = vi.mocked(searchTracks);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const candidate = (over: Partial<SearchCandidate>): SearchCandidate => ({
  title: 'T',
  artist: 'A',
  source: 'deezer',
  isrc: '',
  durationMs: 1000,
  artworkUrl: '',
  ...over,
});

describe('toSearchCandidate', () => {
  it('maps a Spotify search item to a candidate with spotify source', () => {
    const c = toSearchCandidate({
      name: 'Song',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      duration_ms: 200000,
      artists: [{ name: 'Artist' }],
      external_ids: { isrc: 'XX0000000001' },
      album: { images: [{ url: 'https://img/x.jpg' }] },
    });
    expect(c).toEqual({
      title: 'Song',
      artist: 'Artist',
      source: 'spotify',
      spotifyUri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
      isrc: 'XX0000000001',
      durationMs: 200000,
      artworkUrl: 'https://img/x.jpg',
    });
  });

  it('returns null for items without name or uri', () => {
    expect(toSearchCandidate({})).toBeNull();
    expect(toSearchCandidate({ name: '', uri: 'spotify:track:x' })).toBeNull();
    expect(toSearchCandidate({ name: 'S' })).toBeNull();
  });

  it('defaults missing optional fields', () => {
    const c = toSearchCandidate({ name: 'S', uri: 'spotify:track:x' });
    expect(c?.artist).toBe('');
    expect(c?.isrc).toBe('');
    expect(c?.durationMs).toBe(0);
    expect(c?.artworkUrl).toBe('');
  });
});

describe('searchSpotifyTracks', () => {
  it('returns [] without a token', async () => {
    expect(await searchSpotifyTracks('q', async () => null)).toEqual([]);
  });

  it('returns [] on non-OK responses (fail-soft to server results)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    expect(await searchSpotifyTracks('q', async () => 'tok')).toEqual([]);
  });

  it('returns [] on network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    expect(await searchSpotifyTracks('q', async () => 'tok')).toEqual([]);
  });

  it('maps track items and skips unresolvable entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('https://api.spotify.com/v1/search?');
      expect(url).toContain('type=track');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tracks: {
            items: [
              { name: 'S1', uri: 'spotify:track:a', artists: [{ name: 'A1' }] },
              { name: '', uri: 'spotify:track:b' }, // removed track: dropped
            ],
          },
        }),
      };
    }));
    const results = await searchSpotifyTracks('q', async () => 'tok');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('spotify');
    expect(results[0].spotifyUri).toBe('spotify:track:a');
  });
});

describe('mergeSearchResults', () => {
  it('puts spotify results first and appends uncovered server results', () => {
    const sp = [candidate({ title: 'S1', artist: 'A1', source: 'spotify', spotifyUri: 'spotify:track:1' })];
    const srv = [
      candidate({ title: 'D1', artist: 'A2' }),
      candidate({ title: 'D2', artist: 'A3' }),
    ];
    const merged = mergeSearchResults(sp, srv);
    expect(merged.map((c) => c.title)).toEqual(['S1', 'D1', 'D2']);
  });

  it('dedups by ISRC when both entries have one, keeping the spotify entry', () => {
    const sp = [candidate({ title: 'Song', artist: 'Artist', source: 'spotify', spotifyUri: 'spotify:track:1', isrc: 'XX1' })];
    const srv = [candidate({ title: 'Song (Remaster)', artist: 'Artist', isrc: 'XX1' })];
    const merged = mergeSearchResults(sp, srv);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('spotify');
  });

  it('dedups spotify vs deezer by normalized title+artist (deezer has no ISRC)', () => {
    const sp = [candidate({ title: 'Song', artist: 'Artist', source: 'spotify', spotifyUri: 'spotify:track:1', isrc: 'XX1' })];
    const srv = [candidate({ title: 'song', artist: 'artist' })];
    const merged = mergeSearchResults(sp, srv);
    expect(merged).toHaveLength(1);
    expect(merged[0].spotifyUri).toBe('spotify:track:1');
  });

  it('caps the merged list', () => {
    const sp = Array.from({ length: 10 }, (_, i) =>
      candidate({ title: `S${i}`, artist: 'A', source: 'spotify', spotifyUri: `spotify:track:${i}` }));
    const srv = [candidate({ title: 'D1', artist: 'B' })];
    expect(mergeSearchResults(sp, srv, 8)).toHaveLength(8);
  });

  it('returns server results untouched when spotify came back empty', () => {
    const srv = [candidate({ title: 'D1', artist: 'A1' }), candidate({ title: 'D2', artist: 'A2' })];
    expect(mergeSearchResults([], srv)).toEqual(srv);
  });
});

describe('searchAllTracks', () => {
  it('delegates to the server search when spotify is not preferred', async () => {
    const srv = [candidate({ title: 'D1', artist: 'A' })];
    searchTracksMock.mockResolvedValue(srv);
    const results = await searchAllTracks('q', ['apple']);
    expect(results).toEqual(srv);
    expect(searchTracksMock).toHaveBeenCalledWith('q', ['apple']);
  });

  it('merges client-side spotify results ahead of server results when spotify is connected', async () => {
    searchTracksMock.mockResolvedValue([candidate({ title: 'D1', artist: 'A1' })]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tracks: { items: [{ name: 'S1', uri: 'spotify:track:1', artists: [{ name: 'A0' }] }] } }),
    })));
    const results = await searchAllTracks('q', ['spotify'], async () => 'tok');
    expect(results.map((c) => c.source)).toEqual(['spotify', 'deezer']);
  });

  it('falls back to server results when there is no spotify token', async () => {
    const srv = [candidate({ title: 'D1', artist: 'A' })];
    searchTracksMock.mockResolvedValue(srv);
    const results = await searchAllTracks('q', ['spotify'], async () => null);
    expect(results).toEqual(srv);
  });
});
