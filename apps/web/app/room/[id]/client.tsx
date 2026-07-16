'use client';

import { useState, useEffect } from 'react';
import { useStore, joinRoom } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { features } from '@/lib/features';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { ApplePlayer } from '../components/ApplePlayer';
import { SpotifyPlayer } from '../components/SpotifyPlayer';
import { QueuePanel } from '../components/QueuePanel';
import { AddTrackForm } from '../components/AddTrackForm';

export function RoomClient({ roomId }: { roomId: string }) {
  const [nameInput, setNameInput] = useState('');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);
  const [appleAuthorized, setAppleAuthorized] = useState(false);
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(false);
  const store = useStore();
  const nowPlaying = store.state?.nowPlayingId
    ? store.state.queue.find((t) => t.id === store.state!.nowPlayingId)
    : undefined;
  const activeSource = nowPlaying
    ? pickSource(nowPlaying, { appleAuthorized, spotifyAuthorized })
    : null;

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim()) return;

    setLoading(true);
    try {
      await joinRoom(roomId, nameInput);
      setJoined(true);
    } catch (error) {
      console.error('Failed to join:', error);
    } finally {
      setLoading(false);
    }
  };

  if (!joined) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4" style={{ background: 'var(--color-surface-0)' }}>
        <form
          onSubmit={handleJoin}
          className="w-full max-w-sm rounded-xl space-y-6 p-8"
          style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}
        >
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
              music-jam
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Room: {roomId}
            </p>
          </div>

          <input
            type="text"
            placeholder="Your name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            className="w-full px-4 py-3 rounded-lg focus:outline-none transition-all duration-150"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
            autoFocus
          />

          <button
            type="submit"
            disabled={loading || !nameInput.trim()}
            className="w-full px-6 py-3 rounded-lg font-semibold transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 text-base"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
          >
            {loading ? 'Joining...' : 'Join & Play'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--color-surface-0)', color: 'var(--color-text-primary)' }}>
      <div className="border-b" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}>
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold">music-jam</h1>
              <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                Room: {roomId} as {store.name}
              </p>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
              <div
                className="w-2 h-2 rounded-full transition-colors duration-300"
                style={{ backgroundColor: store.connected ? 'var(--color-accent)' : '#ef4444' }}
              />
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {store.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-xl p-6 space-y-4" style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}>
              <div className="flex flex-wrap gap-2">
                {features.spotify && (
                  <SpotifyPlayer authorized={spotifyAuthorized} onAuthorized={setSpotifyAuthorized} />
                )}
                {features.apple && (
                  <ApplePlayer authorized={appleAuthorized} onAuthorized={setAppleAuthorized} />
                )}
              </div>

              {features.youtube && activeSource === 'youtube' && (
                <div className="pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
                  <YouTubePlayer />
                </div>
              )}
            </div>

            <AddTrackForm roomId={roomId} />
          </div>

          <div className="lg:col-span-1">
            <QueuePanel roomId={roomId} />
          </div>
        </div>
      </div>
    </div>
  );
}
