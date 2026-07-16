'use client';

import { useState } from 'react';
import { useStore, queueAdd } from '@/lib/realtime';
import { features } from '@/lib/features';

export function AddTrackForm({ roomId }: { roomId: string }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [videoId, setVideoId] = useState('');
  const [appleSongId, setAppleSongId] = useState('');
  const [spotifyUri, setSpotifyUri] = useState('');
  const [loading, setLoading] = useState(false);
  const name = useStore((s) => s.name);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !artist) return;

    setLoading(true);
    try {
      await queueAdd(roomId, {
        title,
        artist,
        durationMs: undefined,
        sources: {
          ...(videoId ? { youtube: { videoId, confidence: 1 } } : {}),
          ...(appleSongId ? { apple: { songId: appleSongId, confidence: 1 } } : {}),
          ...(spotifyUri ? { spotify: { trackUri: spotifyUri, confidence: 1 } } : {}),
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
    <form onSubmit={handleSubmit} className="rounded-xl p-6 space-y-4" style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}>
      <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Add Track
      </h3>

      <div className="space-y-3">
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
          style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
        />
        <input
          type="text"
          placeholder="Artist"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
          style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
        />

        {features.youtube && (
          <input
            type="text"
            placeholder="YouTube Video ID (optional)"
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
            value={appleSongId}
            onChange={(e) => setAppleSongId(e.target.value)}
            className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
          />
        )}
        {features.spotify && (
          <input
            type="text"
            placeholder="Spotify Track URI (optional)"
            value={spotifyUri}
            onChange={(e) => setSpotifyUri(e.target.value)}
            className="w-full px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
          />
        )}
      </div>

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
