'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { beginAuth, getAccessToken, isAuthed } from '@/lib/spotifyAuth';
import { decidePlayable } from '@/lib/spotifyAccount';
import { getRuntimeEnv, pickEnv } from '@/lib/runtimeEnv';
import { SpotifyIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';
import { detectSpotifyCanSeek } from '@/lib/playerUtils';

// Minimal structural types for the Spotify Web Playback SDK surface we use.
export interface SpotifyPlaybackState {
  position: number;
  track_window?: { current_track?: { duration_ms?: number } };
}

export interface SpotifySDKPlayer {
  connect(): Promise<boolean>;
  getCurrentState(): Promise<SpotifyPlaybackState | null>;
  addListener(event: 'ready', cb: (data: { device_id: string }) => void): boolean;
  addListener(event: string, cb: () => void): boolean;
}

interface SpotifySDKGlobal {
  Player: new (opts: {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
  }) => SpotifySDKPlayer;
}

declare global {
  interface Window {
    Spotify?: SpotifySDKGlobal;
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

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};

/**
 * Spotify player adapter implementing IPlayer interface.
 */
class SpotifyPlayerAdapter implements IPlayer {
  private player: SpotifySDKPlayer;
  private deviceId: string;
  private endedCallbacks: Array<() => void> = [];
  private positionCallbacks: Array<(ms: number) => void> = [];
  private canSeekValue: boolean = false;
  private positionPollInterval: NodeJS.Timeout | null = null;

  constructor(player: SpotifySDKPlayer, deviceId: string, canSeek: boolean) {
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
  const [status, setStatus] = useState<'idle' | 'ready' | 'error'>('idle');
  const state = useStore((s) => s.state);
  const nowPlaying = state?.nowPlayingId
    ? state.queue.find((t) => t.id === state.nowPlayingId)
    : undefined;
  const spotifyUri = nowPlaying?.sources.spotify?.trackUri;
  // Callbacks arrive as fresh inline arrows every render; keep them in refs so
  // the init effect identity stays stable. Otherwise the cleanup below ran on
  // every parent render, disposing the adapter right after ready.
  const onPlayerReadyRef = useRef(onPlayerReady);
  const onPlayerGoneRef = useRef(onPlayerGone);
  useEffect(() => {
    onPlayerReadyRef.current = onPlayerReady;
    onPlayerGoneRef.current = onPlayerGone;
  });

  // Client id resolves from runtime (/env.js) first so the env-agnostic image
  // works, then the build-time fallback; the server snapshot is the build-time
  // value, keeping SSR and the first client render in agreement.
  const clientId = useSyncExternalStore(
    noopSubscribe,
    () => pickEnv(getRuntimeEnv()?.spotifyClientId, process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID),
    () => pickEnv(undefined, process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID),
  );

  useEffect(() => {
    if (!clientId) return;
    // Auth state lives in localStorage (an external system); sync it to the
    // parent once on mount.
    onAuthorized(isAuthed());
  }, [clientId, onAuthorized]);

  useEffect(() => {
    if (!clientId || !authorized || deviceId.current) return;
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
        const Spotify = window.Spotify;
        if (!Spotify) throw new Error('Spotify SDK failed to initialize');
        const player = new Spotify.Player({
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
          onPlayerReadyRef.current?.(adapter);
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
      // Reset readiness so a later re-init goes idle -> ready again: a bare
      // setStatus('ready') with an unchanged value is a React no-op and the
      // load effect below would never re-fire for the new device.
      deviceId.current = null;
      setStatus('idle');
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
        onPlayerGoneRef.current?.();
      }
    };
    // NOTE: `status` must NOT be a dep here. The ready listener calls
    // setStatus('ready'), which would re-run this effect and dispose the
    // adapter immediately after ready.
  }, [clientId, authorized, onAuthorized]);

  useEffect(() => {
    if (!authorized || status !== 'ready' || !deviceId.current || !spotifyUri) return;
    // Read the latest room state imperatively: this effect must fire only when
    // the uri, device readiness, or auth changes, not on every state
    // publication. `status` is the reactive readiness signal: a joiner whose
    // room state arrives before the SDK device is ready gets playUri fired
    // when status flips to 'ready'.
    const current = useStore.getState().state;
    const track = current?.nowPlayingId
      ? current.queue.find((t) => t.id === current.nowPlayingId)
      : undefined;
    if (!track || pickSource(track, { appleAuthorized: false, spotifyAuthorized: authorized }) !== 'spotify') return;
    playUri(deviceId.current, spotifyUri).catch((e) => console.error('Spotify play failed:', e));
  }, [authorized, status, spotifyUri]);

  if (!clientId) return null;
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
