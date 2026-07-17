'use client';

import { useState } from 'react';
import { useStore, queueAdd } from '@/lib/realtime';
import { features } from '@/lib/features';
import { parseYouTube, parseSpotify } from '@/lib/parseTrackInput';

export function AddTrackForm({ roomId }: { roomId: string }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [videoId, setVideoId] = useState('');
  const [appleSongId, setAppleSongId] = useState('');
  const [spotifyUri, setSpotifyUri] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const name = useStore((s) => s.name);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !artist) return;

    // Accept a pasted link or a bare id. A non-empty field that can't be read is
    // surfaced inline, not silently dropped.
    const ytId = videoId.trim() ? parseYouTube(videoId) : null;
    if (videoId.trim() && !ytId) {
      setError("Couldn't read that YouTube link — paste a YouTube link or 11-character video ID.");
      return;
    }
    const spUri = spotifyUri.trim() ? parseSpotify(spotifyUri) : null;
    if (spotifyUri.trim() && !spUri) {
      setError("Couldn't read that Spotify link — paste a Spotify track link or URI.");
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

  return (
    <form onSubmit={handleSubmit} className="panel p-6 space-y-4">
      <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Add Track
      </h3>

      <div className="space-y-3">
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
      </div>

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
  );
}
