'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore, nowPlayingAdvance } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';
import { secondsToMs, msToSeconds } from '@/lib/playerUtils';

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT: any;
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
  private ytPlayer: any;
  private endedCallbacks: Array<() => void> = [];
  private positionCallbacks: Array<(ms: number) => void> = [];
  private positionPollInterval: NodeJS.Timeout | null = null;

  constructor(ytPlayer: any) {
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
  const playerRef = useRef<any>(null);
  const adapterRef = useRef<YouTubePlayerAdapter | null>(null);
  const playerUsable = useRef(false);
  const pendingVideoId = useRef<string | null>(null);
  const nowPlayingIdRef = useRef<string | null>(null);
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
      playerRef.current = new window.YT.Player('youtube-player', {
        width: 480,
        height: 270,
        events: {
          onReady: () => {
            playerUsable.current = true;
            const adapter = new YouTubePlayerAdapter(playerRef.current);
            adapterRef.current = adapter;
            onPlayerReady?.(adapter);
            if (pendingVideoId.current) {
              playerRef.current.loadVideoById(pendingVideoId.current);
              pendingVideoId.current = null;
            }
          },
          onStateChange: (event: any) => {
            if (event.data === 0 && nowPlayingIdRef.current) {
              nowPlayingAdvance(roomId, nowPlayingIdRef.current);
            }
          },
        },
      });
    }

    const track = nowPlayingId ? queue.find((t) => t.id === nowPlayingId) : undefined;
    const videoId = track?.sources.youtube?.videoId;
    if (!videoId) return;

    if (playerUsable.current) {
      playerRef.current.loadVideoById(videoId);
    } else {
      pendingVideoId.current = videoId;
    }
  }, [apiReady, nowPlayingId, queue, roomId, onPlayerReady]);

  useEffect(() => {
    return () => {
      if (adapterRef.current) {
        adapterRef.current.dispose();
        adapterRef.current = null;
        onPlayerGone?.();
      }
    };
  }, [onPlayerGone]);

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
