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
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="max-w-md w-full px-6 py-12 space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-5xl font-bold">music-jam</h1>
          <p className="text-gray-400">
            Collaborative music playback
          </p>
        </div>

        <div className="space-y-4">
          <button
            onClick={handleCreateRoom}
            className="w-full px-6 py-3 bg-blue-600 rounded-lg hover:bg-blue-700 font-medium transition"
          >
            Create Room
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-700" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-gray-950 text-gray-400">or</span>
            </div>
          </div>

          <form onSubmit={handleJoinRoom} className="space-y-3">
            <input
              type="text"
              placeholder="Enter room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg placeholder-gray-500"
            />
            <button
              type="submit"
              className="w-full px-6 py-3 bg-gray-800 rounded-lg hover:bg-gray-700 font-medium transition disabled:opacity-50"
              disabled={!roomId.trim()}
            >
              Join Room
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
