'use client';

import { useState, useRef, useCallback } from 'react';
import { useStore, transportPlay, transportPause, transportSeek } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';

export function formatTime(ms: number): string {
  if (isNaN(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Label for the play/pause control given the current transport state.
export function playPauseLabel(state: string | undefined): 'Play' | 'Pause' {
  return state === 'playing' ? 'Pause' : 'Play';
}

interface TransportUIProps {
  roomId: string;
  activePlayer: IPlayer | null;
  canControl: boolean;
}

export function TransportUI({ roomId, activePlayer, canControl }: TransportUIProps) {
  const store = useStore();
  const [isDragging, setIsDragging] = useState(false);
  // Seed from any already-known transport position: a client joining
  // mid-playback must not show 0:00 until the next publication.
  const [displayPosition, setDisplayPosition] = useState(() => store.state?.transport?.positionMs ?? 0);
  const dragRef = useRef(false);

  const transport = store.state?.transport;
  const isPlaying = transport?.state === 'playing';
  // Duration comes from the now-playing track's metadata (a plain number),
  // not the player's async getDurationMs(); U4 owns live position tracking.
  const nowPlaying = store.state?.queue.find((t) => t.id === store.state?.nowPlayingId);
  const duration = nowPlaying?.durationMs ?? 0;
  const canSeek = activePlayer?.canSeek?.() ?? false;

  // Sync display position with transport state when not dragging (adjust state
  // during render, keyed on the transport object identity).
  const [prevTransport, setPrevTransport] = useState(transport);
  if (!isDragging && transport && transport !== prevTransport) {
    setPrevTransport(transport);
    setDisplayPosition(transport.positionMs);
  }

  const handlePlayPause = useCallback(async () => {
    try {
      if (isPlaying) {
        const pos = activePlayer ? await activePlayer.getCurrentPositionMs() : 0;
        await transportPause(roomId, pos);
      } else {
        await transportPlay(roomId);
      }
    } catch (err) {
      console.error('Transport control error:', err);
    }
  }, [isPlaying, roomId, activePlayer]);

  const handleSeekStart = useCallback(() => {
    setIsDragging(true);
    dragRef.current = true;
  }, []);

  const handleSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayPosition(Number(e.target.value));
  }, []);

  // Commit the seek on release (not per input tick). No-arg so it attaches to
  // mouse/touch/key up events; reads the dragged displayPosition from state.
  const commitSeek = useCallback(() => {
    setIsDragging(false);
    dragRef.current = false;
    transportSeek(roomId, displayPosition).catch((err) => console.error('Seek error:', err));
  }, [roomId, displayPosition]);

  const seekDisabledReason = !canControl
    ? 'Only the host can seek'
    : !canSeek
      ? 'Seeking requires Spotify Premium'
      : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          onClick={handlePlayPause}
          disabled={!activePlayer || !canControl}
          className="flex-shrink-0 w-12 h-12 rounded-lg font-semibold transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 flex items-center justify-center"
          style={{
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-surface-0)',
          }}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          title={canControl ? (isPlaying ? 'Pause playback' : 'Start playback') : 'Only the host can control playback'}
        >
          {isPlaying ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="relative">
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={displayPosition}
              onChange={handleSeekChange}
              onMouseDown={handleSeekStart}
              onTouchStart={handleSeekStart}
              onMouseUp={commitSeek}
              onTouchEnd={commitSeek}
              onKeyUp={commitSeek}
              disabled={!canSeek || !activePlayer || !canControl}
              className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-color disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                backgroundColor: 'var(--color-surface-3)',
                accentColor: 'var(--color-accent)',
              }}
              aria-label="Track position"
              title={seekDisabledReason || 'Seek to position'}
            />
          </div>

          <div className="flex items-center justify-between text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            <span>{formatTime(displayPosition)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {seekDisabledReason && (
        <div className="text-xs px-3 py-1 rounded" style={{ color: 'var(--color-status-warn)', backgroundColor: 'var(--color-surface-2)' }}>
          {seekDisabledReason}
        </div>
      )}
    </div>
  );
}
