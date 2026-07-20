'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { beginAuth, getAccessToken, isAuthed } from '@/lib/spotifyAuth';
import { decidePlayable } from '@/lib/spotifyAccount';
import { getRuntimeEnv, pickEnv } from '@/lib/runtimeEnv';
import { SpotifyIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';
import { detectSpotifyCanSeek } from '@/lib/playerUtils';

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

/**
 * Spotify player adapter implementing IPlayer interface.
 */
class SpotifyPlayerAdapter implements IPlayer {
  private player: any;
  private deviceId: string;
  private endedCallbacks: Array<() => void> = [];
  private positionCallbacks: Array<(ms: number) => void> = [];
  private canSeekValue: boolean = false;
  private positionPollInterval: NodeJS.Timeout | null = null;

  constructor(player: any, deviceId: string, canSeek: boolean) {
    this.player = player;
    this.deviceId = deviceId;
    this.canSeekValue = canSeek;
  }

  async play(): Promise<void> {
    const token = await getAccessToken();
    if (!token) return;
    await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async pause(): Promise<void> {
    const token = await getAccessToken();
    if (!token) return;
    await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async seekToMs(positionMs: number): Promise<void> {
    if (!this.canSeekValue) return;
    const token = await getAccessToken();
    if (!token) return;
    await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${positionMs}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async getCurrentPositionMs(): Promise<number> {
    try {
      const state = await this.player.getCurrentState();
      if (!state) return 0;
      return state.position ?? 0;
    } catch {
      return 0;
    }
  }

  async getDurationMs(): Promise<number> {
    try {
      const state = await this.player.getCurrentState();
      if (!state || !state.track_window?.current_track) return 0;
      return state.track_window.current_track.duration_ms ?? 0;
    } catch {
      return 0;
    }
  }

  canSeek(): boolean {
    return this.canSeekValue;
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
      }, 1000);
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

export function SpotifyPlayer({
  authorized,
  onAuthorized,
  onPlayerReady,
  onPlayerGone,
}: {
  authorized: boolean;
  onAuthorized: (v: boolean) => void;
  onPlayerReady?: (player: IPlayer) => void;
  onPlayerGone?: () => void;
}) {
  const deviceId = useRef<string | null>(null);
  const playerRef = useRef<SpotifyPlayerAdapter | null>(null);
  const [status, setStatus] = useState<'unconfigured' | 'idle' | 'ready' | 'error'>('idle');
  const state = useStore((s) => s.state);
  const nowPlaying = state?.nowPlayingId
    ? state.queue.find((t) => t.id === state.nowPlayingId)
    : undefined;

  useEffect(() => {
    // Enablement is gated where this component is mounted; here we only need a
    // client id, resolved from runtime (/env.js) first so the env-agnostic image
    // works, then the build-time fallback.
    const clientId = pickEnv(getRuntimeEnv()?.spotifyClientId, process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID);
    if (!clientId) {
      setStatus('unconfigured');
      return;
    }
    onAuthorized(isAuthed());
  }, [onAuthorized]);

  useEffect(() => {
    if (status === 'unconfigured' || !authorized || deviceId.current) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (cancelled) return;
        if (!token) {
          onAuthorized(false);
          return;
        }
        const playable = await decidePlayable(token);
        if (cancelled) return;
        if (!playable) {
          onAuthorized(false);
          return;
        }
        await loadSDK();
        if (cancelled) return;
        const player = new window.Spotify.Player({
          name: 'cojam',
          getOAuthToken: (cb: (t: string) => void) => {
            getAccessToken().then((t) => t && cb(t));
          },
          volume: 0.8,
        });
        player.addListener('ready', async ({ device_id }: { device_id: string }) => {
          deviceId.current = device_id;
          const canSeek = await detectSpotifyCanSeek(player);
          const adapter = new SpotifyPlayerAdapter(player, device_id, canSeek);
          playerRef.current = adapter;
          onPlayerReady?.(adapter);
          setStatus('ready');
        });
        player.addListener('authentication_error', () => onAuthorized(false));
        player.addListener('initialization_error', () => setStatus('error'));
        player.addListener('account_error', () => setStatus('error'));
        await player.connect();
      } catch (e) {
        console.error('Spotify SDK init failed:', e);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
        onPlayerGone?.();
      }
    };
  }, [authorized, status, onAuthorized, onPlayerReady, onPlayerGone]);

  useEffect(() => {
    if (!authorized || !deviceId.current || !nowPlaying) return;
    if (pickSource(nowPlaying, { appleAuthorized: false, spotifyAuthorized: authorized }) !== 'spotify') return;
    const uri = nowPlaying.sources.spotify?.trackUri;
    if (uri) playUri(deviceId.current, uri).catch((e) => console.error('Spotify play failed:', e));
  }, [authorized, nowPlaying]);

  if (status === 'unconfigured') return null;
  if (status === 'error') {
    return (
      <div className="text-sm" style={{ color: '#ef4444' }}>
        Spotify unavailable (Premium required)
      </div>
    );
  }

  if (!authorized) {
    return (
      <button
        onClick={() => beginAuth(window.location.pathname)}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
        style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
      >
        <SpotifyIcon size={16} />
        Connect Spotify
      </button>
    );
  }

  const playingHere =
    nowPlaying && pickSource(nowPlaying, { appleAuthorized: false, spotifyAuthorized: true }) === 'spotify';
  return (
    <div className="text-sm inline-flex items-center gap-2" style={{ color: 'var(--color-text-secondary)' }}>
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--color-accent)' }} />
      <span>
        Spotify connected{status === 'ready' ? '' : ' (starting...)'}
        {playingHere && <span style={{ color: 'var(--color-accent)' }}> playing &quot;{nowPlaying!.title}&quot;</span>}
      </span>
    </div>
  );
}
