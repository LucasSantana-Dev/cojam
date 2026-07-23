import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AddTrackForm, planPlaylistImport } from './AddTrackForm';
import { useStore, type SearchCandidate } from '@/lib/realtime';

// Only the RPC functions are mocked; the component drives the real zustand
// store (seeded below) so the render reflects actual app state flow.
const rpcMocks = vi.hoisted(() => ({
  searchTracks: vi.fn<(query: string, prefer?: string[]) => Promise<SearchCandidate[]>>(),
  queueAdd: vi.fn(async () => {}),
  importPlaylist: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  searchTracks: rpcMocks.searchTracks,
  queueAdd: rpcMocks.queueAdd,
  importPlaylist: rpcMocks.importPlaylist,
}));

const SPOTIFY_URL = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const SPOTIFY_URI = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';

describe('planPlaylistImport', () => {
  it('routes authenticated Spotify imports client-side with the playlist id', () => {
    expect(planPlaylistImport(SPOTIFY_URL, true)).toEqual({
      route: 'spotify-client',
      playlistId: '37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(planPlaylistImport(SPOTIFY_URI, true)).toEqual({
      route: 'spotify-client',
      playlistId: '37i9dQZF1DXcBWIGoYBM5M',
    });
  });

  it('flags unauthenticated Spotify URLs as needing auth (no doomed server RPC)', () => {
    expect(planPlaylistImport(SPOTIFY_URL, false)).toEqual({ route: 'spotify-needs-auth' });
  });

  it('routes non-Spotify URLs to the server regardless of auth', () => {
    expect(planPlaylistImport('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', false))
      .toEqual({ route: 'server' });
    expect(planPlaylistImport('https://music.apple.com/us/playlist/example/pl.u-123', true))
      .toEqual({ route: 'server' });
    expect(planPlaylistImport('not a url', false)).toEqual({ route: 'server' });
  });
});

const candidate = (title: string): SearchCandidate => ({
  title,
  artist: 'Some Artist',
  source: 'deezer',
  isrc: 'isrc-1',
  durationMs: 180_000,
  artworkUrl: '',
});

describe('AddTrackForm search-seq guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ name: 'Ana', connectedServices: [] });
    rpcMocks.searchTracks.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a late stale response instead of overwriting the newer results', async () => {
    let resolveStale!: (results: SearchCandidate[]) => void;
    rpcMocks.searchTracks
      .mockImplementationOnce(() => new Promise<SearchCandidate[]>((res) => { resolveStale = res; }))
      .mockResolvedValueOnce([candidate('Fresh Song')]);

    render(<AddTrackForm roomId="r1" />);
    const input = screen.getByRole('textbox', { name: 'Search for a song' });

    // First query fires and stays in flight (the RPC is not abortable).
    fireEvent.change(input, { target: { value: 'old query' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(rpcMocks.searchTracks).toHaveBeenCalledTimes(1);

    // Typing again supersedes it; the newer search resolves first.
    fireEvent.change(input, { target: { value: 'new query' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(rpcMocks.searchTracks).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Fresh Song')).toBeInTheDocument();

    // The stale response must be ignored: results stay on the newer query.
    await act(async () => {
      resolveStale([candidate('Stale Song')]);
    });
    expect(screen.queryByText('Stale Song')).not.toBeInTheDocument();
    expect(screen.getByText('Fresh Song')).toBeInTheDocument();
  });

  it('clears results and skips the RPC when the query is emptied mid-flight', async () => {
    let resolveStale!: (results: SearchCandidate[]) => void;
    rpcMocks.searchTracks
      .mockImplementationOnce(() => new Promise<SearchCandidate[]>((res) => { resolveStale = res; }));

    render(<AddTrackForm roomId="r1" />);
    const input = screen.getByRole('textbox', { name: 'Search for a song' });

    fireEvent.change(input, { target: { value: 'old query' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(rpcMocks.searchTracks).toHaveBeenCalledTimes(1);

    // Clearing the input invalidates the in-flight request (ref-only reset).
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      resolveStale([candidate('Stale Song')]);
    });
    expect(screen.queryByText('Stale Song')).not.toBeInTheDocument();
    expect(rpcMocks.searchTracks).toHaveBeenCalledTimes(1);
  });
});
