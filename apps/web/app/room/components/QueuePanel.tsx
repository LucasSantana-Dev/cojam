'use client';

import { useState } from 'react';
import { useStore, queueRemove, nowPlayingSet, queueReorder, rpcErrorMessage } from '@/lib/realtime';
import {
  SpotifyIcon,
  YouTubeIcon,
  AppleMusicIcon,
  PlayIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
} from '@/app/components/icons';
import { formatTime } from './TransportUI';

// Deezer-style total duration: "1 hr 23 min" / "42 min" / "< 1 min".
function formatTotal(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '< 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} hr ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

interface QueuePanelProps {
  roomId: string;
  canControl: boolean;
}

export function QueuePanel({ roomId, canControl }: QueuePanelProps) {
  const state = useStore((s) => s.state);
  const queue = state?.queue ?? [];
  const nowPlayingId = state?.nowPlayingId;
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [undoTimers, setUndoTimers] = useState<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [actionError, setActionError] = useState('');

  const handleRemove = async (trackId: string, title: string) => {
    // Second click while an undo window is open would schedule a duplicate
    // timer that bypasses Undo; ignore it.
    if (removingIds.has(trackId)) return;
    // Clear any stale action error: a successful removal must not leave a
    // previous failure's alert visible.
    setActionError('');
    setRemovingIds((prev) => new Set([...prev, trackId]));
    const timer = setTimeout(async () => {
      try {
        await queueRemove(roomId, trackId);
      } catch (error) {
        // Disconnected/unauthorized: the track stays; restore and say why.
        console.error('queue.remove failed:', error);
        setActionError(rpcErrorMessage(error, 'Couldn\'t remove that track. Try again.'));
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
    setActionError('');
    try {
      await nowPlayingSet(roomId, trackId);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Couldn\'t play that track. Try again.'));
    }
  };

  const handleMove = async (trackId: string, toIndex: number) => {
    setActionError('');
    try {
      await queueReorder(roomId, trackId, toIndex);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Couldn\'t reorder the queue. Try again.'));
    }
  };

  const handleMoveUp = async (trackId: string, currentIndex: number) => {
    if (currentIndex > 0) {
      await handleMove(trackId, currentIndex - 1);
    }
  };

  const handleMoveDown = async (trackId: string, currentIndex: number) => {
    if (currentIndex < queue.length - 1) {
      await handleMove(trackId, currentIndex + 1);
    }
  };

  const getInitial = (name: string): string => {
    return name.charAt(0).toUpperCase();
  };

  // Aggregate header (R2). Duration only when every row reports one, so the
  // total is never silently partial. `!= null`: 0ms is known metadata.
  const totalDurationMs = queue.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const allDurationsKnown = queue.length > 0 && queue.every((t) => t.durationMs != null);
  const contributors = new Set(queue.map((t) => t.addedBy)).size;
  const isPlaying = state?.transport?.state === 'playing';
  const aggregate = [
    `${queue.length} ${queue.length === 1 ? 'track' : 'tracks'}`,
    allDurationsKnown ? formatTotal(totalDurationMs) : null,
    `${contributors} ${contributors === 1 ? 'contributor' : 'contributors'}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="panel p-6 space-y-4 h-fit lg:sticky lg:top-24">
      <div>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Queue
        </h3>
        {queue.length > 0 && <p className="queue-agg">{aggregate}</p>}
      </div>

      {actionError && (
        <p role="alert" aria-live="polite" className="text-sm" style={{ color: 'var(--color-status-error)' }}>
          {actionError}
        </p>
      )}

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
        <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
          {queue.map((track, index) => (
            <div
              key={track.id}
              data-testid="queue-item"
              className={`queue-item-row animate-fade-in-up group${track.id === nowPlayingId ? ' is-now' : ''}${removingIds.has(track.id) ? ' removing' : ''}`}
              style={track.id === nowPlayingId ? { borderLeft: '3px solid var(--color-accent)' } : {}}
            >
              <div className="flex w-full items-center justify-between gap-2 p-2.5 rounded-lg transition-all duration-150 hover:bg-[color-mix(in_oklab,var(--color-accent)_3%,transparent)] focus-within:bg-[color-mix(in_oklab,var(--color-accent)_3%,transparent)]">
                {/* Left side: position + track info */}
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <div className="text-xs font-semibold flex-shrink-0 w-6 text-center" style={{ color: track.id === nowPlayingId ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
                    {track.id === nowPlayingId && isPlaying ? (
                      <span className="inline-flex gap-0.5">
                        <span className="inline-block w-1 h-2 rounded-sm bg-current" style={{ animation: 'eq-bounce 0.9s ease-in-out infinite' }} />
                        <span className="inline-block w-1 h-3 rounded-sm bg-current" style={{ animation: 'eq-bounce 0.9s ease-in-out infinite', animationDelay: '-0.5s' }} />
                        <span className="inline-block w-1 h-2 rounded-sm bg-current" style={{ animation: 'eq-bounce 0.9s ease-in-out infinite', animationDelay: '-0.1s' }} />
                      </span>
                    ) : (
                      index + 1
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div data-testid="queue-title" className="font-medium text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>
                      {track.title}
                    </div>
                    <div className="text-xs truncate flex items-center gap-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {track.artist}
                      <span className="text-opacity-60">·</span>
                      <span className="avatar-chip-sm inline-flex" style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)', width: '18px', height: '18px', fontSize: '0.6rem', padding: 0 }}>
                        {getInitial(track.addedBy)}
                      </span>
                      <span className="flex-shrink-0">{track.addedBy}</span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {track.sources.youtube && (
                        <span
                          className="badge-source badge-youtube inline-flex items-center text-xs"
                          title={`YouTube match ${Math.round(track.sources.youtube.confidence * 100)}%`}
                        >
                          <YouTubeIcon size={10} />
                        </span>
                      )}
                      {track.sources.apple && (
                        <span
                          className="badge-source badge-apple inline-flex items-center text-xs"
                          title={`Apple Music match ${Math.round(track.sources.apple.confidence * 100)}%`}
                        >
                          <AppleMusicIcon size={10} />
                        </span>
                      )}
                      {track.sources.spotify && (
                        <span
                          className="badge-source badge-spotify inline-flex items-center text-xs"
                          title={`Spotify match ${Math.round(track.sources.spotify.confidence * 100)}%`}
                        >
                          <SpotifyIcon size={10} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Per-row duration (R9): right-aligned tabular, before the
                    hover-revealed controls. */}
                {track.durationMs != null && (
                  <span className="queue-duration">{formatTime(track.durationMs)}</span>
                )}

                {/* Right side: controls (hidden on desktop hover, always visible on touch) */}
                <div className="queue-controls flex gap-1 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    onClick={() => handlePlay(track.id)}
                    disabled={!canControl}
                    aria-label="Play"
                    title={canControl ? 'Play' : 'Only the host can play tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:brightness-110 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
                  >
                    <PlayIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleMoveUp(track.id, index)}
                    disabled={index === 0 || !canControl}
                    aria-label="Move up"
                    title={canControl ? 'Move up' : 'Only the host can reorder tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:opacity-70 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-primary)' }}
                  >
                    <ArrowUpIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleMoveDown(track.id, index)}
                    disabled={index === queue.length - 1 || !canControl}
                    aria-label="Move down"
                    title={canControl ? 'Move down' : 'Only the host can reorder tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:opacity-70 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-primary)' }}
                  >
                    <ArrowDownIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleRemove(track.id, track.title)}
                    disabled={!canControl}
                    aria-label="Remove"
                    title={canControl ? 'Remove' : 'Only the host can remove tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:opacity-70 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-primary)' }}
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
