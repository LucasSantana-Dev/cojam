'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore, nowPlayingAdvance } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';
import { secondsToMs, msToSeconds } from '@/lib/playerUtils';

// Minimal structural types for the YouTube IFrame API surface this adapter uses.
interface YTPlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  loadVideoById(videoId: string): void;
}

interface YTGlobal {
  Player: new (
    elementId: string,
    opts: {
      width?: number;
      height?: number;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
      };
    }
  ) => YTPlayerInstance;
}

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: YTGlobal;
  }
}

const apiReadyCallbacks: Array<() => void> = [];

function loadYouTubeAPI(onReady: () => void) {
  if (window.YT?.Player) {
    onReady();
    return;
  }
  apiReadyCallbacks.push(onReady);
  if (document.querySelector('script[src*="youtube.com/iframe_api"]')) return;

  window.onYouTubeIframeAPIReady = () => {
    apiReadyCallbacks.splice(0).forEach((cb) => cb());
  };
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  document.body.appendChild(script);
}

/**
 * YouTube player adapter implementing IPlayer interface.
 * YouTube IFrame API measures time in seconds; we convert to/from milliseconds.
 */
class YouTubePlayerAdapter implements IPlayer {
  private ytPlayer: YTPlayerInstance;
  private endedCallbacks: Array<() => void> = [];
  private positionCallbacks: Array<(ms: number) => void> = [];
  private positionPollInterval: NodeJS.Timeout | null = null;

  constructor(ytPlayer: YTPlayerInstance) {
    this.ytPlayer = ytPlayer;
  }

  async play(): Promise<void> {
    this.ytPlayer.playVideo();
  }

  async pause(): Promise<void> {
    this.ytPlayer.pauseVideo();
  }

  async seekToMs(positionMs: number): Promise<void> {
    this.ytPlayer.seekTo(msToSeconds(positionMs), true);
  }

  async getCurrentPositionMs(): Promise<number> {
    try {
      const seconds = this.ytPlayer.getCurrentTime();
      return secondsToMs(seconds);
    } catch {
      return 0;
    }
  }

  async getDurationMs(): Promise<number> {
    try {
      const seconds = this.ytPlayer.getDuration();
      return secondsToMs(seconds);
    } catch {
      return 0;
    }
  }

  canSeek(): boolean {
    return true;
  }

  onEnded(cb: () => void): void {
    this.endedCallbacks.push(cb);
  }

  onPositionChanged(cb: (positionMs: number) => void): void {
    this.positionCallbacks.push(cb);
    if (!this.positionPollInterval) {
      this.positionPollInterval = setInterval(async () => {
        const pos = await this.getCurrentPositionMs();
        this.positionCallbacks.forEach((c) => c(pos));
      }, 500);
    }
  }

  dispose(): void {
    if (this.positionPollInterval) {
      clearInterval(this.positionPollInterval);
      this.positionPollInterval = null;
    }
    this.endedCallbacks = [];
    this.positionCallbacks = [];
  }
}

export function YouTubePlayer({
  roomId,
  onPlayerReady,
  onPlayerGone,
}: {
  roomId: string;
  onPlayerReady?: (player: IPlayer) => void;
  onPlayerGone?: () => void;
}) {
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const adapterRef = useRef<YouTubePlayerAdapter | null>(null);
  const playerUsable = useRef(false);
  const pendingVideoId = useRef<string | null>(null);
  const nowPlayingIdRef = useRef<string | null>(null);
  // Callbacks arrive as fresh inline arrows every render; keep them in refs so
  // effect identity stays stable. Without this the unmount cleanup below ran on
  // every render, disposing the adapter and nulling activePlayer right after
  // onPlayerReady set it (Play button permanently disabled).
  const onPlayerReadyRef = useRef(onPlayerReady);
  const onPlayerGoneRef = useRef(onPlayerGone);
  useEffect(() => {
    onPlayerReadyRef.current = onPlayerReady;
    onPlayerGoneRef.current = onPlayerGone;
  });
  const [apiReady, setApiReady] = useState(false);
  const state = useStore((s) => s.state);
  const nowPlayingId = state?.nowPlayingId;
  const queue = state?.queue ?? [];

  useEffect(() => {
    loadYouTubeAPI(() => setApiReady(true));
  }, []);

  useEffect(() => {
    nowPlayingIdRef.current = nowPlayingId ?? null;
  }, [nowPlayingId]);

  useEffect(() => {
    if (!apiReady) return;

    if (!playerRef.current) {
      const YT = window.YT;
      if (!YT) return;
      const player = new YT.Player('youtube-player', {
        width: 480,
        height: 270,
        events: {
          onReady: () => {
            playerUsable.current = true;
            const adapter = new YouTubePlayerAdapter(player);
            adapterRef.current = adapter;
            onPlayerReadyRef.current?.(adapter);
            if (pendingVideoId.current) {
              player.loadVideoById(pendingVideoId.current);
              pendingVideoId.current = null;
            }
          },
          onStateChange: (event: { data: number }) => {
            if (event.data === 0 && nowPlayingIdRef.current) {
              nowPlayingAdvance(roomId, nowPlayingIdRef.current);
            }
          },
        },
      });
      playerRef.current = player;
    }

    const track = nowPlayingId ? queue.find((t) => t.id === nowPlayingId) : undefined;
    const videoId = track?.sources.youtube?.videoId;
    if (!videoId) return;

    const player = playerRef.current;
    if (!player) return;
    if (playerUsable.current) {
      player.loadVideoById(videoId);
    } else {
      pendingVideoId.current = videoId;
    }
  }, [apiReady, nowPlayingId, queue, roomId, onPlayerReady]);

  useEffect(() => {
    return () => {
      if (adapterRef.current) {
        adapterRef.current.dispose();
        adapterRef.current = null;
        onPlayerGoneRef.current?.();
      }
    };
  }, []);

  const nowPlaying = nowPlayingId ? queue.find((t) => t.id === nowPlayingId) : undefined;

  return (
    <div className="space-y-4">
      <div id="youtube-player" className="w-full rounded-lg overflow-hidden" />
      {nowPlaying && (
        <div className="text-sm space-y-1">
          <div className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            {nowPlaying.title}
          </div>
          <div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            by {nowPlaying.artist}
          </div>
        </div>
      )}
    </div>
  );
}
