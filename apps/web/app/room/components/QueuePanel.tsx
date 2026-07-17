'use client';

import { useState } from 'react';
import { useStore, queueRemove, nowPlayingSet, queueReorder } from '@/lib/realtime';
import {
  SpotifyIcon,
  YouTubeIcon,
  AppleMusicIcon,
  PlayIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
} from '@/app/components/icons';

export function QueuePanel({ roomId }: { roomId: string }) {
  const state = useStore((s) => s.state);
  const queue = state?.queue ?? [];
  const nowPlayingId = state?.nowPlayingId;
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [undoTimers, setUndoTimers] = useState<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleRemove = async (trackId: string, title: string) => {
    // Second click while an undo window is open would schedule a duplicate
    // timer that bypasses Undo; ignore it.
    if (removingIds.has(trackId)) return;
    setRemovingIds((prev) => new Set([...prev, trackId]));
    const timer = setTimeout(async () => {
      try {
        await queueRemove(roomId, trackId);
      } catch (error) {
        // Disconnected/unauthorized: the track stays; just log and restore.
        console.error('queue.remove failed:', error);
      } finally {
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.delete(trackId);
          return next;
        });
        setUndoTimers((prev) => {
          const next = new Map(prev);
          next.delete(trackId);
          return next;
        });
      }
    }, 4000);

    setUndoTimers((prev) => new Map(prev).set(trackId, timer));
  };

  const handleUndo = (trackId: string) => {
    const timer = undoTimers.get(trackId);
    if (timer) {
      clearTimeout(timer);
    }
    setRemovingIds((prev) => {
      const next = new Set(prev);
      next.delete(trackId);
      return next;
    });
    setUndoTimers((prev) => {
      const next = new Map(prev);
      next.delete(trackId);
      return next;
    });
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
    <div className="panel p-6 space-y-4 h-fit lg:sticky lg:top-24">
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
              data-testid="queue-item"
              className={`queue-item animate-fade-in-up flex flex-col items-start justify-between gap-3 p-3 rounded-lg group${track.id === nowPlayingId ? ' is-now' : ''}${removingIds.has(track.id) ? ' removing' : ''}`}
            >
              <div className="flex w-full items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div data-testid="queue-title" className="font-medium text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>
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
                      <span className="badge-source badge-youtube inline-flex items-center gap-1">
                        <YouTubeIcon size={12} /> {Math.round(track.sources.youtube.confidence * 100)}%
                      </span>
                    )}
                    {track.sources.apple && (
                      <span className="badge-source badge-apple inline-flex items-center gap-1">
                        <AppleMusicIcon size={12} /> {Math.round(track.sources.apple.confidence * 100)}%
                      </span>
                    )}
                    {track.sources.spotify && (
                      <span className="badge-source badge-spotify inline-flex items-center gap-1">
                        <SpotifyIcon size={12} /> {Math.round(track.sources.spotify.confidence * 100)}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-2 ml-2 flex-shrink-0">
                  <button
                    onClick={() => handlePlay(track.id)}
                    aria-label="Play"
                    title="Play"
                    className="inline-flex items-center justify-center px-2 py-1 rounded transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
                    style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
                  >
                    <PlayIcon size={16} />
                  </button>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleMoveUp(track.id, index)}
                      disabled={index === 0}
                      aria-label="Move up"
                      title="Move up"
                      className="flex-1 inline-flex items-center justify-center px-2 py-1 rounded border transition-all duration-150 hover:opacity-70 active:scale-95 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ backgroundColor: 'var(--color-surface-3)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                    >
                      <ArrowUpIcon size={14} />
                    </button>
                    <button
                      onClick={() => handleMoveDown(track.id, index)}
                      disabled={index === queue.length - 1}
                      aria-label="Move down"
                      title="Move down"
                      className="flex-1 inline-flex items-center justify-center px-2 py-1 rounded border transition-all duration-150 hover:opacity-70 active:scale-95 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ backgroundColor: 'var(--color-surface-3)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                    >
                      <ArrowDownIcon size={14} />
                    </button>
                  </div>
                  <button
                    onClick={() => handleRemove(track.id, track.title)}
                    aria-label="Remove"
                    title="Remove"
                    className="inline-flex items-center justify-center px-2 py-1 rounded border transition-all duration-150 hover:opacity-70 active:scale-95 focus:outline-none"
                    style={{ backgroundColor: 'var(--color-surface-3)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>

              {removingIds.has(track.id) && (
                <div className="undo-affordance w-full flex items-center justify-between">
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    Removed {track.title.length > 30 ? track.title.slice(0, 27) + '...' : track.title}
                  </span>
                  <button
                    onClick={() => handleUndo(track.id)}
                    className="text-xs font-semibold px-2 py-1 rounded transition-all duration-150 hover:brightness-110"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    Undo
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
