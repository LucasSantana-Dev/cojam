'use client';

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { useStore, transportPlay, transportPause, transportSeek, nowPlayingAdvance } from '@/lib/realtime';
import { SkipPrevIcon, SkipNextIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';

export function formatTime(ms: number): string {
  if (isNaN(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Label for the play/pause control given the current transport state.
export function playPauseLabel(state: string | undefined): 'Tocar' | 'Pausar' {
  return state === 'playing' ? 'Pausar' : 'Tocar';
}

// Keys that actually move the slider. Tab/Escape are focus navigation, not
// seek intent, so their keyup must not commit a transport.seek RPC.
const SEEK_COMMIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']);
// Held/repeated arrow keys fire one keyup each; debounce so a burst commits
// one RPC per pause instead of one per keyup.
const SEEK_KEYUP_DEBOUNCE_MS = 300;

interface TransportUIProps {
  roomId: string;
  activePlayer: IPlayer | null;
  canControl: boolean;
  // Rendered at the right end of the control row (the local volume).
  trailing?: ReactNode;
}

export function TransportUI({ roomId, activePlayer, canControl, trailing }: TransportUIProps) {
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
  const metaDuration = nowPlaying?.durationMs ?? 0;
  // Hand-added video links carry no durationMs, which left the slider at
  // max=0 (unseekable). Fall back to the player's own duration, polled until
  // known; a track-supplied duration always wins.
  const [playerDuration, setPlayerDuration] = useState<{ id: string; ms: number } | null>(null);
  const nowPlayingId = nowPlaying?.id;
  useEffect(() => {
    if (!activePlayer || !nowPlayingId || metaDuration > 0) return;
    let cancelled = false;
    // YouTube getDuration() returns the previous video's length right after a
    // load; only trust it once the player reports PLAYING for this video.
    // Players without isPlaying (no state to check) are trusted as before.
    const poll = () => {
      if (activePlayer.isPlaying && !activePlayer.isPlaying()) return;
      return activePlayer
        .getDurationMs()
        .then((d) => {
          if (cancelled || !Number.isFinite(d) || d <= 0) return;
          setPlayerDuration({ id: nowPlayingId, ms: d });
          clearInterval(timer); // known: stop polling (timer is initialised before any poll resolves)
        })
        .catch(() => {});
    };
    const timer = setInterval(poll, 1000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activePlayer, nowPlayingId, metaDuration]);
  const fallbackDuration = playerDuration && playerDuration.id === nowPlayingId ? playerDuration.ms : 0;
  const duration = metaDuration > 0 ? metaDuration : fallbackDuration;
  const canSeek = activePlayer?.canSeek?.() ?? false;

  // Sync display position with transport state when not dragging (adjust state
  // during render, keyed on the transport object identity).
  const [prevTransport, setPrevTransport] = useState(transport);
  // Compared by field, not identity: the server heartbeat (#258) delivers a
  // fresh transport object every 10s with identical values, which must not
  // snap the slider back to the last published position.
  const transportChanged =
    !!transport &&
    (!prevTransport ||
      transport.state !== prevTransport.state ||
      transport.positionMs !== prevTransport.positionMs ||
      transport.updatedAtServerMs !== prevTransport.updatedAtServerMs);
  if (!isDragging && transport && transportChanged) {
    setPrevTransport(transport);
    setDisplayPosition(transport.positionMs);
  }

  // Live position readout while playing. dragRef (not state) keeps the
  // subscription stable across drag toggles; updates are suppressed mid-drag
  // so the poll never fights the user's slider.
  useEffect(() => {
    if (!activePlayer) return;
    activePlayer.onPositionChanged((pos) => {
      if (!dragRef.current) setDisplayPosition(pos);
    });
  }, [activePlayer]);

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

  // "Previous" restarts the track: the room keeps no play history to go back to.
  const handleRestart = useCallback(() => {
    transportSeek(roomId, 0).catch((err) => console.error('Restart error:', err));
  }, [roomId]);

  // Skip to the next queued track; the server picks it and dedups with auto-advance.
  const handleNext = useCallback(() => {
    if (!nowPlayingId) return;
    nowPlayingAdvance(roomId, nowPlayingId).catch((err) => console.error('Skip error:', err));
  }, [roomId, nowPlayingId]);

  const handleSeekStart = useCallback(() => {
    setIsDragging(true);
    dragRef.current = true;
  }, []);

  const handleSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayPosition(Number(e.target.value));
  }, []);

  // Commit the seek on release (not per input tick). No-arg so it attaches to
  // mouse/touch up events; reads the dragged displayPosition from state.
  const commitSeek = useCallback(() => {
    setIsDragging(false);
    dragRef.current = false;
    transportSeek(roomId, displayPosition).catch((err) => console.error('Seek error:', err));
  }, [roomId, displayPosition]);

  const keySeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel a pending debounced keyboard seek on unmount.
  useEffect(() => {
    return () => {
      if (keySeekTimerRef.current) clearTimeout(keySeekTimerRef.current);
    };
  }, []);

  // Keyboard seeks commit only on keys that move the slider (Tab/Escape are
  // ignored) and are debounced so repeated keyups fire one RPC per pause.
  const handleSeekKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!SEEK_COMMIT_KEYS.has(e.key)) return;
      setIsDragging(false);
      dragRef.current = false;
      if (keySeekTimerRef.current) clearTimeout(keySeekTimerRef.current);
      keySeekTimerRef.current = setTimeout(() => {
        keySeekTimerRef.current = null;
        transportSeek(roomId, displayPosition).catch((err) => console.error('Seek error:', err));
      }, SEEK_KEYUP_DEBOUNCE_MS);
    },
    [roomId, displayPosition]
  );

  const seekDisabledReason = !canControl
    ? 'Só o anfitrião pode mudar o ponto da faixa'
    : !canSeek
      ? 'Mudar o ponto da faixa requer Spotify Premium'
      : '';

  const pct = duration > 0 ? Math.min(100, Math.max(0, (displayPosition / duration) * 100)) : 0;

  return (
    <div className="tp">
      <div className="tp__bar">
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
          onKeyUp={handleSeekKeyUp}
          disabled={!canSeek || !activePlayer || !canControl}
          className="tp__range"
          style={{ ['--pct' as string]: `${pct}%` }}
          aria-label="Posição da faixa"
          title={seekDisabledReason || 'Ir para este ponto'}
        />
        <div className="tp__times">
          <span>{formatTime(displayPosition)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="tp__row">
        <span className="tp__side" aria-hidden="true" />
        <div className="tp__ctrls">
          <button
            type="button"
            onClick={handleRestart}
            disabled={!activePlayer || !canControl || !canSeek}
            className="tp__skip"
            aria-label="Voltar ao início da faixa"
            title={canControl ? 'Voltar ao início da faixa' : 'Só o anfitrião controla a reprodução'}
          >
            <SkipPrevIcon size={24} />
          </button>
          <button
            onClick={handlePlayPause}
            disabled={!activePlayer || !canControl}
            className="transport-play tp__play"
            aria-label={isPlaying ? 'Pausar' : 'Tocar'}
            title={canControl ? (isPlaying ? 'Pausar' : 'Tocar') : 'Só o anfitrião controla a reprodução'}
          >
            {isPlaying ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canControl || !nowPlayingId}
            className="tp__skip"
            aria-label="Próxima faixa"
            title={canControl ? 'Próxima faixa' : 'Só o anfitrião controla a reprodução'}
          >
            <SkipNextIcon size={24} />
          </button>
        </div>
        <span className="tp__side tp__side--end">{trailing}</span>
      </div>

      {seekDisabledReason && <p className="tp__note">{seekDisabledReason}</p>}
    </div>
  );
}
