'use client';

import { useState } from 'react';
import { useStore, queueAdd } from '@/lib/realtime';

export function AddTrackForm({ roomId }: { roomId: string }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [videoId, setVideoId] = useState('');
  const [appleSongId, setAppleSongId] = useState('');
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
        },
        addedBy: name,
      });
      setTitle('');
      setArtist('');
      setVideoId('');
      setAppleSongId('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 p-4 bg-gray-900 rounded">
      <h3 className="text-lg font-semibold">Add Track</h3>
      <input
        type="text"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm"
      />
      <input
        type="text"
        placeholder="Artist"
        value={artist}
        onChange={(e) => setArtist(e.target.value)}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm"
      />
      <input
        type="text"
        placeholder="YouTube Video ID (optional)"
        value={videoId}
        onChange={(e) => setVideoId(e.target.value)}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm"
      />
      <input
        type="text"
        placeholder="Apple Music Song ID (optional)"
        value={appleSongId}
        onChange={(e) => setAppleSongId(e.target.value)}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm"
      />
      <button
        type="submit"
        disabled={loading || !title || !artist}
        className="w-full px-4 py-2 bg-blue-900 rounded hover:bg-blue-800 disabled:opacity-50 text-sm font-medium"
      >
        {loading ? 'Adding...' : 'Add to Queue'}
      </button>
    </form>
  );
}
