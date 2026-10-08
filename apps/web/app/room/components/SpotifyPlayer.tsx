'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { beginAuth, getAccessToken, isAuthed, needsSpotifyReconnect } from '@/lib/spotifyAuth';
import { checkAccount } from '@/lib/spotifyAccount';
import {
  canRetrySpotifyConnect,
  kindFromAccountCheck,
  spotifyConnectMessage,
  type SpotifyConnectErrorKind,
} from '@/lib/spotifyConnectError';
import { getRuntimeEnv, pickEnv } from '@/lib/runtimeEnv';
import { SpotifyIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';
import { detectSpotifyCanSeek, createEndedDetector, createSpotifyEndDetector, type SpotifyEndState } from '@/lib/playerUtils';

// Minimal structural types for the Spotify Web Playback SDK surface we use.
export interface SpotifyPlaybackState {
  position: number;
  paused?: boolean;
  track_window?: {
    current_track?: { duration_ms?: number; id?: string | null; uri?: string };
    previous_tracks?: Array<{ id?: string | null; uri?: string }>;
  };
}

export interface SpotifySDKPlayer {
  connect(): Promise<boolean>;
  getCurrentState(): Promise<SpotifyPlaybackState | null>;
  pause?(): Promise<void>;
  setVolume?(volume: number): Promise<void>;
  addListener(event: 'ready', cb: (data: { device_id: string }) => void): boolean;
  addListener(event: 'player_state_changed', cb: (state: SpotifyPlaybackState | null) => void): boolean;
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
  const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [uri] }),
  });
  if (!res.ok) throw new Error(`Spotify play failed: ${res.status}`);
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
  private endedDetector = createEndedDetector();
  private stateEndDetector = createSpotifyEndDetector();
  // The track CoJam asked the SDK to play, and the one an advance was already
  // sent for: the poll and state paths share this latch (one advance per track).
  private expectedUri: string | null = null;
  private advancedFor: string | null = null;

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

  setVolume(level: number): void {
    void this.player.setVolume?.(level)?.catch?.(() => {});
  }

  // Pause only this browser's SDK device. pause() goes through the Web API and
  // pauses whatever device the account is playing on, which is wrong when the
  // person just switched away from Spotify to listen elsewhere.
  async pauseLocal(): Promise<void> {
    await this.player.pause?.();
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
    // End detection must not depend on a position subscriber (the transport
    // bar) being mounted.
    this.startPolling();
  }

  // Fed by the SDK's player_state_changed: catches the natural end of a track
  // (paused at position 0 with the track in previous_tracks), which the
  // position poll cannot see.
  setExpected(uri: string | null): void {
    if (uri !== this.expectedUri) this.advancedFor = null;
    this.expectedUri = uri;
  }

  private emitEnded(): void {
    if (this.advancedFor !== null && this.advancedFor === this.expectedUri) return;
    this.advancedFor = this.expectedUri;
    this.endedCallbacks.forEach((c) => c());
  }

  handleStateChange(state: SpotifyEndState | null): void {
    const end = this.stateEndDetector(state, this.expectedUri);
    if (!end) {
      // Replay of the same track (position back near 0, playing) re-arms.
      if (state && !state.paused && state.position > 0 && state.position < 5000) this.advancedFor = null;
      return;
    }
    // Spotify Autoplay (or a skip in the user's own app) moved to a track the
    // room never queued: stop it so it does not play while the room advances.
    if (end === 'foreign') void this.player.pause?.()?.catch?.(() => {});
    this.emitEnded();
  }

  onPositionChanged(cb: (positionMs: number) => void): void {
    this.positionCallbacks.push(cb);
    this.startPolling();
  }

  private startPolling(): void {
    if (!this.positionPollInterval) {
      this.positionPollInterval = setInterval(async () => {
        try {
          const state = await this.player.getCurrentState();
          const pos = state?.position ?? 0;
          const duration = state?.track_window?.current_track?.duration_ms ?? 0;
          this.positionCallbacks.forEach((c) => c(pos));
          if (this.endedDetector(pos, duration)) this.emitEnded();
        } catch {
          // Keep polling; a transient SDK read failure is not fatal.
        }
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
    this.endedDetector = createEndedDetector();
    this.stateEndDetector = createSpotifyEndDetector();
  }
}

export function SpotifyPlayer({
  authorized,
  onAuthorized,
  onPlayerReady,
  onPlayerGone,
  onPlayError,
  active,
}: {
  authorized: boolean;
  // Whether Spotify is the service that plays the now-playing track for this
  // client (the "Ouvir no" choice resolved by pickSource). Omitted: derived
  // from authorization alone, the auto behaviour. When it turns false the SDK
  // is paused so it never plays under another service.
  active?: boolean;
  onAuthorized: (v: boolean) => void;
  onPlayerReady?: (player: IPlayer) => void;
  onPlayerGone?: () => void;
  // Per-user playback failure surface: called with the track id when this
  // client can't play the now-playing track, null when playback (re)starts.
  onPlayError?: (trackId: string | null) => void;
}) {
  const deviceId = useRef<string | null>(null);
  const playerRef = useRef<SpotifyPlayerAdapter | null>(null);
  const [status, setStatus] = useState<'idle' | 'ready' | 'error'>('idle');
  // Why Spotify is not usable right now; shown next to the connect button.
  const [problem, setProblem] = useState<SpotifyConnectErrorKind | null>(null);
  const state = useStore((s) => s.state);
  const nowPlaying = state?.nowPlayingId
    ? state.queue.find((t) => t.id === state.nowPlayingId)
    : undefined;
  const spotifyUri = nowPlaying?.sources.spotify?.trackUri;
  // Re-runs the load effect when the room starts playing (a load skipped while paused).
  const roomPlaying = state?.transport?.state === 'playing';
  // The uri this SDK device was last told to load.
  const loadedUriRef = useRef<string | null>(null);
  // Callbacks arrive as fresh inline arrows every render; keep them in refs so
  // the init effect identity stays stable. Otherwise the cleanup below ran on
  // every parent render, disposing the adapter right after ready.
  const onPlayerReadyRef = useRef(onPlayerReady);
  const onPlayerGoneRef = useRef(onPlayerGone);
  const onPlayErrorRef = useRef(onPlayError);
  useEffect(() => {
    onPlayerReadyRef.current = onPlayerReady;
    onPlayerGoneRef.current = onPlayerGone;
    onPlayErrorRef.current = onPlayError;
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
          setProblem(needsSpotifyReconnect() ? 'reconnect' : 'unknown');
          onAuthorized(false);
          return;
        }
        const problemKind = kindFromAccountCheck(await checkAccount(token));
        if (cancelled) return;
        if (problemKind) {
          setProblem(problemKind);
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
          player.addListener('player_state_changed', (st) => adapter.handleStateChange(st));
          onPlayerReadyRef.current?.(adapter);
          setProblem(null);
          setStatus('ready');
        });
        player.addListener('authentication_error', () => {
          setProblem('reconnect');
          onAuthorized(false);
        });
        player.addListener('initialization_error', () => {
          setProblem('sdk');
          setStatus('error');
        });
        player.addListener('account_error', () => {
          setProblem('premium');
          setStatus('error');
        });
        await player.connect();
      } catch (e) {
        console.error('Spotify SDK init failed:', e);
        if (!cancelled) {
          setProblem('sdk');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      // Reset readiness so a later re-init goes idle -> ready again: a bare
      // setStatus('ready') with an unchanged value is a React no-op and the
      // load effect below would never re-fire for the new device.
      deviceId.current = null;
      loadedUriRef.current = null;
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
    const wanted = active ?? (track ? pickSource(track, { appleAuthorized: false, spotifyAuthorized: authorized }) === 'spotify' : false);
    if (!track || !wanted) return;
    // Never start audio in a paused or stopped room (a switch to Spotify there
    // must stay silent); the effect re-runs when the room starts playing.
    const ts = current?.transport?.state;
    if (ts && ts !== 'playing') return;
    // Load each uri on the device once: a pause/play cycle resumes through the
    // drift-corrected transport instead of restarting the track.
    if (loadedUriRef.current === spotifyUri) return;
    loadedUriRef.current = spotifyUri;
    playerRef.current?.setExpected(spotifyUri);
    playUri(deviceId.current, spotifyUri)
      .then(() => onPlayErrorRef.current?.(null))
      .catch((e) => {
        loadedUriRef.current = null;
        console.error('Spotify play failed:', e);
        onPlayErrorRef.current?.(track.id);
      });
  }, [authorized, status, spotifyUri, active, roomPlaying]);

  // Switched to another service mid-track: stop the SDK. The new player takes
  // the synced position through the existing drift correction.
  useEffect(() => {
    if (active !== false || status !== 'ready') return;
    loadedUriRef.current = null;
    playerRef.current?.setExpected(null);
    playerRef.current?.pauseLocal().catch(() => {});
  }, [active, status]);

  if (!clientId) return null;
  const connect = () => {
    setProblem(null);
    beginAuth(window.location.pathname).catch(() => setProblem('unknown'));
  };
  const problemKind = problem ?? 'unknown';
  const problemNote = (
    <div
      role="alert"
      data-testid="spotify-connect-error"
      className="text-sm"
      style={{ color: 'var(--color-status-error)' }}
    >
      {spotifyConnectMessage(problemKind)}
    </div>
  );
  const connectButton = (label: string) => (
    <button
      onClick={connect}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
      style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
    >
      <SpotifyIcon size={16} />
      {label}
    </button>
  );

  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2">
        {problemNote}
        {canRetrySpotifyConnect(problemKind) && connectButton('Tentar de novo')}
      </div>
    );
  }

  if (!authorized) {
    if (!problem) return connectButton('Conectar Spotify');
    // Premium: the account is the problem, so offer no button to loop on.
    if (!canRetrySpotifyConnect(problem)) return problemNote;
    return (
      <div className="flex flex-col items-start gap-2">
        {connectButton('Tentar de novo')}
        {problemNote}
      </div>
    );
  }

  return (
    <div className="text-sm inline-flex items-center gap-2" style={{ color: 'var(--color-text-secondary)' }}>
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--color-accent)' }} />
      <span>
        Spotify conectado{status === 'ready' ? '' : ' (iniciando...)'}
      </span>
    </div>
  );
}
