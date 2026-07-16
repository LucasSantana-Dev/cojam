'use client';

import { useEffect, useRef } from 'react';
import { useStore } from '@/lib/realtime';

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT: any;
  }
}

let YT: any;
let playerReady = false;

function loadYouTubeAPI() {
  if (document.querySelector('script[src*="youtube"]')) return;

  window.onYouTubeIframeAPIReady = () => {
    playerReady = true;
  };

  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  document.body.appendChild(script);
}

export function YouTubePlayer() {
  const playerRef = useRef<ReturnType<typeof window.YT.Player> | null>(null);
  const state = useStore((s) => s.state);
  const nowPlayingId = state?.nowPlayingId;
  const queue = state?.queue ?? [];

  useEffect(() => {
    loadYouTubeAPI();
  }, []);

  useEffect(() => {
    if (!playerReady || !window.YT) return;

    if (!playerRef.current) {
      playerRef.current = new window.YT.Player('youtube-player', {
        width: 480,
        height: 270,
        videoId: '',
        events: {
          onReady: () => {},
          onStateChange: () => {},
        },
      });
    }

    if (nowPlayingId) {
      const track = queue.find((t) => t.id === nowPlayingId);
      if (track?.sources.youtube?.videoId) {
        playerRef.current.loadVideoById(track.sources.youtube.videoId);
      }
    }
  }, [nowPlayingId, queue]);

  return (
    <div className="space-y-4">
      <div id="youtube-player" className="w-full" />
      {nowPlayingId && queue.find((t) => t.id === nowPlayingId) && (
        <div className="text-sm">
          <div className="font-semibold">
            {queue.find((t) => t.id === nowPlayingId)?.title}
          </div>
          <div className="text-gray-400">
            {queue.find((t) => t.id === nowPlayingId)?.artist}
          </div>
        </div>
      )}
    </div>
  );
}
