'use client';

import { useStore, queueRemove, nowPlayingSet } from '@/lib/realtime';

export function QueuePanel({ roomId }: { roomId: string }) {
  const state = useStore((s) => s.state);
  const queue = state?.queue ?? [];

  const handleRemove = async (trackId: string) => {
    await queueRemove(roomId, trackId);
  };

  const handlePlay = async (trackId: string) => {
    await nowPlayingSet(roomId, trackId);
  };

  return (
    <div className="space-y-2 max-h-96 overflow-y-auto">
      <h3 className="text-lg font-semibold">Queue</h3>
      {queue.length === 0 ? (
        <p className="text-gray-400 text-sm">Queue is empty</p>
      ) : (
        <div className="space-y-2">
          {queue.map((track) => (
            <div
              key={track.id}
              className="flex items-center justify-between p-2 bg-gray-900 rounded text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{track.title}</div>
                <div className="text-gray-400 text-xs truncate">
                  {track.artist} by {track.addedBy}
                </div>
                <div className="flex gap-1 mt-1">
                  {track.sources.youtube && (
                    <span className="text-xs bg-red-900 px-2 py-0.5 rounded">
                      YT {Math.round(track.sources.youtube.confidence * 100)}%
                    </span>
                  )}
                  {track.sources.apple && (
                    <span className="text-xs bg-gray-800 px-2 py-0.5 rounded">
                      Apple {Math.round(track.sources.apple.confidence * 100)}%
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 ml-2">
                <button
                  onClick={() => handlePlay(track.id)}
                  className="px-2 py-1 bg-green-900 rounded hover:bg-green-800 text-xs"
                >
                  Play
                </button>
                <button
                  onClick={() => handleRemove(track.id)}
                  className="px-2 py-1 bg-red-900 rounded hover:bg-red-800 text-xs"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
