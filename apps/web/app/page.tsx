'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default function Home() {
  const [roomId, setRoomId] = useState('');
  const router = useRouter();

  const handleCreateRoom = () => {
    const id = generateRoomId();
    router.push(`/room/${id}`);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      router.push(`/room/${roomId.trim().toUpperCase()}`);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-4" style={{ background: 'var(--color-surface-0)' }}>
      <div className="max-w-sm w-full space-y-12">
        <div className="text-center space-y-3">
          <h1 className="text-5xl font-bold tracking-tight" style={{ color: 'var(--color-text-primary)' }}>
            music-jam
          </h1>
          <p className="text-lg" style={{ color: 'var(--color-text-secondary)' }}>
            Collaborative music playback
          </p>
        </div>

        <div className="space-y-4">
          <button
            onClick={handleCreateRoom}
            className="w-full px-6 py-3 font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 text-base"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
          >
            Create Room
          </button>

          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full h-px" style={{ backgroundColor: 'var(--color-border)' }} />
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 text-sm" style={{ background: 'var(--color-surface-0)', color: 'var(--color-text-muted)' }}>
                or
              </span>
            </div>
          </div>

          <form onSubmit={handleJoinRoom} className="space-y-3">
            <input
              type="text"
              placeholder="Enter room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
              className="w-full px-4 py-3 rounded-lg focus:border-4 focus:outline-none transition-all duration-150"
            />
            <button
              type="submit"
              disabled={!roomId.trim()}
              className="w-full px-6 py-3 rounded-lg font-semibold transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 text-base"
              style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
            >
              Join Room
            </button>
          </form>
        </div>

        <div className="text-center">
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Invite others with a room ID
          </p>
        </div>
      </div>
    </div>
  );
}
