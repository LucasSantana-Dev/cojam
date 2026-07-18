'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore, transportPlay, transportPause, transportSeek } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';

export function formatTime(ms: number): string {
  if (isNaN(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface TransportUIProps {
  roomId: string;
  activePlayer: IPlayer | null;
}

export function TransportUI({ roomId, activePlayer }: TransportUIProps) {
  const store = useStore();
  const [isDragging, setIsDragging] = useState(false);
  const [displayPosition, setDisplayPosition] = useState(0);
  const dragRef = useRef(false);

  const transport = store.state?.transport;
  const isPlaying = transport?.state === 'playing';
  const duration = activePlayer ? activePlayer.getDurationMs?.() ?? 0 : 0;
  const canSeek = activePlayer?.canSeek?.() ?? false;

  // Sync display position with transport state when not dragging
  useEffect(() => {
    if (!isDragging && transport) {
      setDisplayPosition(transport.positionMs);
    }
  }, [transport, isDragging]);

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

  const handleSeekEnd = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const position = Number(e.target.value);
    setDisplayPosition(position);
    setIsDragging(false);
    dragRef.current = false;
    try {
      await transportSeek(roomId, position);
    } catch (err) {
      console.error('Seek error:', err);
    }
  }, [roomId]);

  const seekDisabledReason = !canSeek ? 'Seeking requires Spotify Premium' : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          onClick={handlePlayPause}
          disabled={!activePlayer}
          className="flex-shrink-0 w-12 h-12 rounded-lg font-semibold transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 flex items-center justify-center"
          style={{
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-surface-0)',
          }}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          title={isPlaying ? 'Pause playback' : 'Start playback'}
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
              onMouseUp={handleSeekEnd}
              onTouchEnd={handleSeekEnd}
              disabled={!canSeek || !activePlayer}
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
        <div className="text-xs px-3 py-1 rounded" style={{ color: 'var(--color-status-warn)', backgroundColor: 'rgba(112, 128, 144, 0.1)' }}>
          {seekDisabledReason}
        </div>
      )}
    </div>
  );
}
