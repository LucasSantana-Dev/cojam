'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { beginAuth, getAccessToken, isAuthed } from '@/lib/spotifyAuth';
import { features } from '@/lib/features';

declare global {
  interface Window {
    Spotify: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

async function loadSDK(): Promise<void> {
  if (window.Spotify) return;
  await new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.onerror = () => reject(new Error('spotify-player.js failed to load'));
    document.body.appendChild(script);
  });
}

async function playUri(deviceId: string, uri: string) {
  const token = await getAccessToken();
  if (!token) return;
  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [uri] }),
  });
}

export function SpotifyPlayer({
  authorized,
  onAuthorized,
}: {
  authorized: boolean;
  onAuthorized: (v: boolean) => void;
}) {
  const deviceId = useRef<string | null>(null);
  const [status, setStatus] = useState<'unconfigured' | 'idle' | 'ready' | 'error'>('idle');
  const state = useStore((s) => s.state);
  const nowPlaying = state?.nowPlayingId
    ? state.queue.find((t) => t.id === state.nowPlayingId)
    : undefined;

  // Gated by feature flag, then by config (public client id present)
  useEffect(() => {
    if (!features.spotify || !process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID) {
      setStatus('unconfigured');
      return;
    }
    onAuthorized(isAuthed());
  }, [onAuthorized]);

  // Init the Web Playback SDK once authorized
  useEffect(() => {
    if (status === 'unconfigured' || !authorized || deviceId.current) return;
    let cancelled = false;
    (async () => {
      try {
        await loadSDK();
        if (cancelled) return;
        const player = new window.Spotify.Player({
          name: 'music-jam',
          getOAuthToken: (cb: (t: string) => void) => {
            getAccessToken().then((t) => t && cb(t));
          },
          volume: 0.8,
        });
        player.addListener('ready', ({ device_id }: { device_id: string }) => {
          deviceId.current = device_id;
          setStatus('ready');
        });
        player.addListener('authentication_error', () => onAuthorized(false));
        player.addListener('initialization_error', () => setStatus('error'));
        player.addListener('account_error', () => setStatus('error')); // non-Premium
        await player.connect();
      } catch (e) {
        console.error('Spotify SDK init failed:', e);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorized, status, onAuthorized]);

  // Play now-playing when this client's pick is Spotify
  useEffect(() => {
    if (!authorized || !deviceId.current || !nowPlaying) return;
    if (pickSource(nowPlaying, { appleAuthorized: false, spotifyAuthorized: authorized }) !== 'spotify') return;
    const uri = nowPlaying.sources.spotify?.trackUri;
    if (uri) playUri(deviceId.current, uri).catch((e) => console.error('Spotify play failed:', e));
  }, [authorized, nowPlaying]);

  if (status === 'unconfigured') return null;
  if (status === 'error') return <div className="text-sm text-red-400">Spotify unavailable (Premium required)</div>;

  if (!authorized) {
    return (
      <button
        onClick={() => beginAuth(window.location.pathname)}
        className="px-4 py-2 bg-green-700 rounded hover:bg-green-600 text-sm font-medium"
      >
        Connect Spotify
      </button>
    );
  }

  const playingHere =
    nowPlaying && pickSource(nowPlaying, { appleAuthorized: false, spotifyAuthorized: true }) === 'spotify';
  return (
    <div className="text-sm text-gray-400">
      Spotify connected{status === 'ready' ? '' : ' (starting…)'}
      {playingHere && <span className="text-green-400"> — playing “{nowPlaying!.title}”</span>}
    </div>
  );
}
