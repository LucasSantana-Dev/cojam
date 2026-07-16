'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore, nowPlayingAdvance } from '@/lib/realtime';

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

export function YouTubePlayer({ roomId }: { roomId: string }) {
  const playerRef = useRef<any>(null);
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
            if (pendingVideoId.current) {
              playerRef.current.loadVideoById(pendingVideoId.current);
              pendingVideoId.current = null;
            }
          },
          onStateChange: (event: any) => {
            // YT.PlayerState.ENDED = 0
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
  }, [apiReady, nowPlayingId, queue, roomId]);

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
