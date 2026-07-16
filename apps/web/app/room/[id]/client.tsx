'use client';

import { useState, useEffect } from 'react';
import { useStore, joinRoom } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { ApplePlayer } from '../components/ApplePlayer';
import { QueuePanel } from '../components/QueuePanel';
import { AddTrackForm } from '../components/AddTrackForm';

export function RoomClient({ roomId }: { roomId: string }) {
  const [nameInput, setNameInput] = useState('');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);
  const [appleAuthorized, setAppleAuthorized] = useState(false);
  const store = useStore();
  const nowPlaying = store.state?.nowPlayingId
    ? store.state.queue.find((t) => t.id === store.state!.nowPlayingId)
    : undefined;
  const activeSource = nowPlaying ? pickSource(nowPlaying, { appleAuthorized }) : null;

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
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <form
          onSubmit={handleJoin}
          className="p-8 bg-gray-900 rounded-lg space-y-4 w-96"
        >
          <h1 className="text-3xl font-bold text-center">music-jam</h1>
          <div className="text-center text-gray-400 text-sm">
            Room: {roomId}
          </div>
          <input
            type="text"
            placeholder="Your name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded"
            autoFocus
          />
          <button
            type="submit"
            disabled={loading || !nameInput.trim()}
            className="w-full px-4 py-2 bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {loading ? 'Joining...' : 'Join & Play'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">music-jam</h1>
            <div className="text-gray-400 text-sm">
              Room: {roomId} as {store.name}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                store.connected ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-400">
              {store.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-6">
            <div className="p-4 bg-gray-900 rounded space-y-3">
              <ApplePlayer authorized={appleAuthorized} onAuthorized={setAppleAuthorized} />
              {activeSource !== 'apple' && <YouTubePlayer />}
            </div>
            <AddTrackForm roomId={roomId} />
          </div>

          <div>
            <QueuePanel roomId={roomId} />
          </div>
        </div>
      </div>
    </div>
  );
}
