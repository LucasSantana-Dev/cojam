'use client';

import { useStore, queueRemove, nowPlayingSet, queueReorder } from '@/lib/realtime';

export function QueuePanel({ roomId }: { roomId: string }) {
  const state = useStore((s) => s.state);
  const queue = state?.queue ?? [];

  const handleRemove = async (trackId: string) => {
    await queueRemove(roomId, trackId);
  };

  const handlePlay = async (trackId: string) => {
    await nowPlayingSet(roomId, trackId);
  };

  const handleMoveUp = async (trackId: string, currentIndex: number) => {
    if (currentIndex > 0) {
      await queueReorder(roomId, trackId, currentIndex - 1);
    }
  };

  const handleMoveDown = async (trackId: string, currentIndex: number) => {
    if (currentIndex < queue.length - 1) {
      await queueReorder(roomId, trackId, currentIndex + 1);
    }
  };

  const getInitial = (name: string): string => {
    return name.charAt(0).toUpperCase();
  };

  return (
    <div className="rounded-xl p-6 space-y-4 h-fit" style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)' }}>
      <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Queue
      </h3>

      {queue.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Queue is empty
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Add a track to get started
          </p>
        </div>
      ) : (
        <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
          {queue.map((track, index) => (
            <div
              key={track.id}
              className="queue-item animate-fade-in-up flex items-start justify-between gap-3 p-3 rounded-lg group"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>
                  {track.title}
                </div>
                <div className="text-xs truncate mt-1 flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
                  <span className="avatar-chip-sm" style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}>
                    {getInitial(track.addedBy)}
                  </span>
                  {track.artist} by {track.addedBy}
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {track.sources.youtube && (
                    <span className="badge-source badge-youtube">
                      YT {Math.round(track.sources.youtube.confidence * 100)}%
                    </span>
                  )}
                  {track.sources.apple && (
                    <span className="badge-source badge-apple">
                      Apple {Math.round(track.sources.apple.confidence * 100)}%
                    </span>
                  )}
                  {track.sources.spotify && (
                    <span className="badge-source badge-spotify">
                      Spotify {Math.round(track.sources.spotify.confidence * 100)}%
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2 ml-2">
                <button
                  onClick={() => handlePlay(track.id)}
                  name="Play"
                  className="px-2 py-1 text-xs font-medium rounded transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
                  style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
                >
                  Play
                </button>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleMoveUp(track.id, index)}
                    disabled={index === 0}
                    name="Up"
                    className="flex-1 px-2 py-1 text-xs font-medium rounded border transition-all duration-150 hover:opacity-70 active:scale-95 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => handleMoveDown(track.id, index)}
                    disabled={index === queue.length - 1}
                    name="Down"
                    className="flex-1 px-2 py-1 text-xs font-medium rounded border transition-all duration-150 hover:opacity-70 active:scale-95 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                  >
                    ↓
                  </button>
                </div>
                <button
                  onClick={() => handleRemove(track.id)}
                  name="Remove"
                  className="px-2 py-1 text-xs font-medium rounded border transition-all duration-150 hover:opacity-70 active:scale-95 focus:outline-none"
                  style={{ backgroundColor: 'var(--color-surface-3)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
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
