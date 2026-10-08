'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore, nowPlayingAdvance, isPermissionDeniedError } from '@/lib/realtime';
import type { TrackRef } from '@cojam/shared';
import type { IPlayer } from '@/lib/playerInterface';
import { computeExpectedPosition, isExpectedPositionKnown, serverNow } from '@/lib/playbackSync';
import { secondsToMs, msToSeconds, createEndedDetector } from '@/lib/playerUtils';

// Minimal structural types for the YouTube IFrame API surface this adapter uses.
interface YTPlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState?(): number;
  getVideoData?(): { video_id?: string };
  loadVideoById(videoId: string | { videoId: string; startSeconds?: number }): void;
  setVolume?(volume: number): void;
  mute?(): void;
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
        onError?: (event: { data: number }) => void;
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

// YT embed error codes for tracks that can never play in the iframe: 100 =
// removed/private, 101 and 150 = embedding disabled by the owner.
export function isUnplayableYtError(code: number): boolean {
  return code === 100 || code === 101 || code === 150;
}

// Start a freshly loaded video at the synced position instead of 0: a seek
// issued before the video is PLAYING can be dropped, restarting it at 0.
function loadArg(videoId: string): string | { videoId: string; startSeconds: number } {
  const t = useStore.getState().state?.transport;
  if (!t || t.state === 'stopped') return videoId;
  const now = serverNow();
  if (!isExpectedPositionKnown(t, now)) return videoId;
  const startSeconds = msToSeconds(computeExpectedPosition(t, now));
  return startSeconds > 0 ? { videoId, startSeconds } : videoId;
}

// Stable empty-queue fallback: `?? []` inline would create a new array identity
// every render, re-running the player effect below each time.
const EMPTY_QUEUE: TrackRef[] = [];

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
  private endedDetector = createEndedDetector();

  constructor(ytPlayer: YTPlayerInstance) {
    this.ytPlayer = ytPlayer;
  }

  async play(): Promise<void> {
    this.ytPlayer.playVideo();
  }

  async pause(): Promise<void> {
    this.ytPlayer.pauseVideo();
  }

  setVolume(level: number): void {
    try {
      this.ytPlayer.setVolume?.(Math.round(level * 100));
    } catch {
      /* player not ready yet; applied again when it announces itself */
    }
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
      return Number.isFinite(seconds) ? secondsToMs(seconds) : 0;
    } catch {
      return 0;
    }
  }

  getLoadedVideoId(): string | null {
    try {
      return this.ytPlayer.getVideoData?.().video_id ?? null;
    } catch {
      return null;
    }
  }

  canSeek(): boolean {
    return true;
  }

  // YT.PlayerState.PAUSED === 2
  isPaused(): boolean {
    try {
      return this.ytPlayer.getPlayerState ? this.ytPlayer.getPlayerState() === 2 : false;
    } catch {
      return false;
    }
  }

  // YT.PlayerState.PLAYING === 1. Without getPlayerState it is not playing.
  isPlaying(): boolean {
    try {
      return this.ytPlayer.getPlayerState ? this.ytPlayer.getPlayerState() === 1 : false;
    } catch {
      return false;
    }
  }

  onEnded(cb: () => void): void {
    this.endedCallbacks.push(cb);
  }

  onPositionChanged(cb: (positionMs: number) => void): void {
    this.positionCallbacks.push(cb);
    if (!this.positionPollInterval) {
      this.positionPollInterval = setInterval(async () => {
        const pos = await this.getCurrentPositionMs();
        const duration = await this.getDurationMs();
        this.positionCallbacks.forEach((c) => c(pos));
        if (this.endedDetector(pos, duration)) {
          this.endedCallbacks.forEach((c) => c());
        }
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
    this.endedDetector = createEndedDetector();
  }
}

export function YouTubePlayer({
  roomId,
  onPlayerReady,
  onPlayerGone,
  onPlayError,
  fill = false,
  muted = false,
}: {
  roomId: string;
  onPlayerReady?: (player: IPlayer) => void;
  onPlayerGone?: () => void;
  // Per-user playback failure surface: called with the track id when this
  // client can't play the now-playing track, null when playback (re)starts.
  onPlayError?: (trackId: string | null) => void;
  // Stage mode (#258): the host container owns sizing and the title, so render
  // the bare player element filling it instead of the audio-room card.
  fill?: boolean;
  // Modo palco, decision 8: a muted, visual-only video for a listener on
  // another service. It never advances the room at its end (the audio player
  // owns that) and its owner (useVisualSync) keeps it in step.
  muted?: boolean;
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
  const onPlayErrorRef = useRef(onPlayError);
  // Fixed per mount (a muted palco video is its own instance).
  const mutedRef = useRef(muted);
  useEffect(() => {
    onPlayerReadyRef.current = onPlayerReady;
    onPlayerGoneRef.current = onPlayerGone;
    onPlayErrorRef.current = onPlayError;
  });
  const [apiReady, setApiReady] = useState(false);
  const nowPlayingId = useStore((s) => s.state?.nowPlayingId);
  const queueMaybe = useStore((s) => s.state?.queue);
  const queue = queueMaybe ?? EMPTY_QUEUE;

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
            if (mutedRef.current) {
              player.mute?.();
              player.setVolume?.(0);
            }
            const adapter = new YouTubePlayerAdapter(player);
            adapterRef.current = adapter;
            onPlayerReadyRef.current?.(adapter);
            if (pendingVideoId.current) {
              player.loadVideoById(loadArg(pendingVideoId.current));
              pendingVideoId.current = null;
            }
          },
          onStateChange: (event: { data: number }) => {
            // PLAYING: playback actually started, clear any prior failure.
            if (event.data === 1) onPlayErrorRef.current?.(null);
            if (event.data === 0 && nowPlayingIdRef.current && !mutedRef.current) {
              // Advance is control-gated on the server: a listener's rejection is expected.
              nowPlayingAdvance(roomId, nowPlayingIdRef.current).catch((err) => {
                if (!isPermissionDeniedError(err)) console.warn('[youtube] advance at track end failed:', err);
              });
            }
          },
          onError: (event: { data: number }) => {
            if (isUnplayableYtError(event.data) && nowPlayingIdRef.current) {
              onPlayErrorRef.current?.(nowPlayingIdRef.current);
            }
          },
        },
      });
      playerRef.current = player;
    }

    // Read the queue imperatively: this effect must re-run only when apiReady
    // or nowPlayingId changes, not on every state publication (a fresh queue
    // array identity per publication used to restart the current video).
    const queueNow = useStore.getState().state?.queue ?? EMPTY_QUEUE;
    const track = nowPlayingId ? queueNow.find((t) => t.id === nowPlayingId) : undefined;
    const videoId = track?.sources.youtube?.videoId;
    if (!videoId) return;

    const player = playerRef.current;
    if (!player) return;
    if (playerUsable.current) {
      player.loadVideoById(loadArg(videoId));
    } else {
      pendingVideoId.current = videoId;
    }
  }, [apiReady, nowPlayingId, roomId]);

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

  if (fill) {
    return <div id="youtube-player" className="h-full w-full" />;
  }

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
