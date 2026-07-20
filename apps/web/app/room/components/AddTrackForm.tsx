'use client';

import { useState, useEffect, useRef } from 'react';
import { useStore, queueAdd, searchTracks, importPlaylist, buildProviderPrefs, type SearchCandidate } from '@/lib/realtime';
import { features } from '@/lib/features';
import { parseYouTube, parseSpotify } from '@/lib/parseTrackInput';

export function AddTrackForm({ roomId, spotifyAuthorized, appleAuthorized }: { roomId: string; spotifyAuthorized?: boolean; appleAuthorized?: boolean }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchCandidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [playlistInputRef, setPlaylistInputRef] = useState<HTMLInputElement | null>(null);
  const [importErrorShake, setImportErrorShake] = useState(false);

  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [videoId, setVideoId] = useState('');
  const [appleSongId, setAppleSongId] = useState('');
  const [spotifyUri, setSpotifyUri] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [playlistUrl, setPlaylistUrl] = useState('');
  const [playlistError, setPlaylistError] = useState('');
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistSuccess, setPlaylistSuccess] = useState('');

  const name = useStore((s) => s.name);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Monotonic request id: only the latest search may apply its result, so a slow
  // stale query (the RPC is not abortable) cannot overwrite a newer one.
  const searchSeqRef = useRef(0);

  // Debounced search
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!searchQuery.trim()) {
      searchSeqRef.current++;
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const seq = ++searchSeqRef.current;
    setIsSearching(true);
    setSearchResults([]); // stale results must not render under the skeleton
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchTracks(searchQuery, buildProviderPrefs({ spotify: spotifyAuthorized, apple: appleAuthorized }));
        if (searchSeqRef.current === seq) setSearchResults(results);
      } catch {
        if (searchSeqRef.current === seq) setSearchResults([]);
      } finally {
        if (searchSeqRef.current === seq) setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [searchQuery, spotifyAuthorized, appleAuthorized]);

  const handleSearchResultClick = async (result: SearchCandidate) => {
    setLoading(true);
    try {
      await queueAdd(roomId, {
        title: result.title,
        artist: result.artist,
        durationMs: result.durationMs,
        isrc: result.isrc,
        sources: {
          ...(result.spotifyUri ? { spotify: { trackUri: result.spotifyUri, confidence: 1 } } : {}),
        },
        addedBy: name,
      });
      setSearchQuery('');
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !artist) return;

    // Accept a pasted link or a bare id. A non-empty field that can't be read is
    // surfaced inline, not silently dropped.
    const ytId = videoId.trim() ? parseYouTube(videoId) : null;
    if (videoId.trim() && !ytId) {
      setError("Couldn't read that YouTube link - paste a YouTube link or 11-character video ID.");
      return;
    }
    const spUri = spotifyUri.trim() ? parseSpotify(spotifyUri) : null;
    if (spotifyUri.trim() && !spUri) {
      setError("Couldn't read that Spotify link - paste a Spotify track link or URI.");
      return;
    }
    setError('');

    setLoading(true);
    try {
      await queueAdd(roomId, {
        title,
        artist,
        durationMs: undefined,
        sources: {
          ...(ytId ? { youtube: { videoId: ytId, confidence: 1 } } : {}),
          ...(appleSongId ? { apple: { songId: appleSongId, confidence: 1 } } : {}),
          ...(spUri ? { spotify: { trackUri: spUri, confidence: 1 } } : {}),
        },
        addedBy: name,
      });
      setTitle('');
      setArtist('');
      setVideoId('');
      setAppleSongId('');
      setSpotifyUri('');
    } finally {
      setLoading(false);
    }
  };

  const handlePlaylistImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!playlistUrl.trim()) return;

    setPlaylistError('');
    setPlaylistSuccess('');
    setPlaylistLoading(true);

    try {
      await importPlaylist(roomId, playlistUrl, name);
      setPlaylistUrl('');
      setPlaylistSuccess('Playlist tracks added to queue');
      setTimeout(() => setPlaylistSuccess(''), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import playlist';
      setPlaylistError(message);
      setImportErrorShake(true);
      setTimeout(() => setImportErrorShake(false), 600);
    } finally {
      setPlaylistLoading(false);
    }
  };

  return (
    <div className="panel p-6 space-y-4">
      <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Add Track
      </h3>

      <div className="space-y-2">
        <div className="relative">
          <input
            type="text"
            placeholder="Search for a song"
            aria-label="Search for a song"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2.5 text-sm rounded-lg focus:outline-none transition-all duration-150 border"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: searchQuery ? 'var(--color-accent)' : 'var(--color-border)', color: 'var(--color-text-primary)' }}
          />
        </div>

        {/* Results dropdown: appears when searching or results available */}
        {searchQuery && (
          <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
            {isSearching && (
              <div className="space-y-2 p-3">
                {[...Array(3)].map((_, idx) => (
                  <div
                    key={idx}
                    className="skeleton-shimmer h-12 rounded-lg"
                  />
                ))}
              </div>
            )}

            {!isSearching && searchResults.length > 0 && (
              <ul className="space-y-0">
                {searchResults.map((result, idx) => (
                  <li
                    key={`${result.source}-${result.title}-${idx}`}
                    className="search-result-enter border-b last:border-b-0 hover:bg-[color-mix(in_oklab,var(--color-accent)_2%,transparent)]"
                    style={{ borderBottomColor: 'var(--color-border)', ['--i' as string]: idx } as React.CSSProperties}
                  >
                    <button
                      type="button"
                      onClick={() => handleSearchResultClick(result)}
                      disabled={loading}
                      className="w-full text-left px-3 py-2 text-sm focus:outline-none transition-all duration-150 flex items-center justify-between gap-3 group"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {result.artworkUrl && (
                          <img
                            src={result.artworkUrl}
                            alt=""
                            className="w-10 h-10 rounded object-cover flex-shrink-0"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate text-sm">{result.title}</span>
                            <span className="inline-block px-1.5 py-0.5 text-xs rounded flex-shrink-0" style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-secondary)' }}>
                              {result.source}
                            </span>
                          </div>
                          <div className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
                            {result.artist}
                          </div>
                        </div>
                      </div>
                      <span
                        aria-hidden="true"
                        className="px-2.5 py-1.5 text-xs font-semibold rounded flex-shrink-0 transition-all duration-150 group-hover:brightness-110 group-active:scale-90"
                        style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
                      >
                        + Add
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!isSearching && searchResults.length === 0 && (
              <div className="p-4 text-center">
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  No matches found. Try a different search, or add manually.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Empty state: before any typing */}
        {!searchQuery && (
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Start typing to search...
          </p>
        )}
      </div>

      <div className="pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <form onSubmit={handlePlaylistImport} className="space-y-2">
          <label className="block text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            Import a playlist
          </label>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                ref={setPlaylistInputRef}
                type="url"
                placeholder="Paste playlist link"
                aria-label="Playlist URL"
                value={playlistUrl}
                onChange={(e) => setPlaylistUrl(e.target.value)}
                className={`w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150${importErrorShake ? ' import-error-shake' : ''}`}
                style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                disabled={playlistLoading}
              />
              {playlistLoading && (
                <div className="import-progress absolute bottom-0 left-0 right-0 rounded-b-lg overflow-hidden">
                  <div className="import-progress-bar" />
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={playlistLoading || !playlistUrl.trim()}
              className="px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 focus:outline-none whitespace-nowrap"
              style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
            >
              {playlistLoading ? 'Importing...' : 'Import'}
            </button>
          </div>
          {playlistError && (
            <p role="alert" aria-live="polite" className="text-sm" style={{ color: 'var(--color-status-error)' }}>
              {playlistError}
            </p>
          )}
          {playlistSuccess && (
            <p role="status" aria-live="polite" className="success-toast text-sm" style={{ color: '#86efac' }}>
              {playlistSuccess}
            </p>
          )}
        </form>
      </div>

      <details className="cursor-pointer">
        <summary className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          Add manually
        </summary>
        <form onSubmit={handleSubmit} className="space-y-3 mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <input
            type="text"
            placeholder="Title"
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
          />
          <input
            type="text"
            placeholder="Artist"
            aria-label="Artist"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
          />

          {features.youtube && (
            <input
              type="text"
              placeholder="YouTube link or video ID (optional)"
              aria-label="YouTube link or video ID (optional)"
              value={videoId}
              onChange={(e) => setVideoId(e.target.value)}
              className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
              style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
            />
          )}
          {features.apple && (
            <input
              type="text"
              placeholder="Apple Music Song ID (optional)"
              aria-label="Apple Music Song ID (optional)"
              value={appleSongId}
              onChange={(e) => setAppleSongId(e.target.value)}
              className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
              style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
            />
          )}
          {features.spotify && (
            <input
              type="text"
              placeholder="Spotify link or track URI (optional)"
              aria-label="Spotify link or track URI (optional)"
              value={spotifyUri}
              onChange={(e) => setSpotifyUri(e.target.value)}
              className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
              style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
            />
          )}

          <p role="alert" aria-live="polite" className="text-sm" style={{ color: '#f87171', minHeight: error ? undefined : 0 }}>
            {error}
          </p>

          <button
            type="submit"
            disabled={loading || !title || !artist}
            className="w-full px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 focus:outline-none"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
          >
            {loading ? 'Adding...' : 'Add to Queue'}
          </button>
        </form>
      </details>
    </div>
  );
}
