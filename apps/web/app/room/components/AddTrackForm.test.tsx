import { describe, it, expect } from 'vitest';
import { planPlaylistImport } from './AddTrackForm';

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
