'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { features } from '@/lib/features';
import { AppleMusicIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';

// Minimal structural types for the MusicKit v3 surface this adapter uses.
interface MusicKitInstance {
  play(): Promise<void>;
  pause(): Promise<void>;
  seekToTime(seconds: number): Promise<void>;
  setQueue(opts: { songs: string[] }): Promise<unknown>;
  authorize(): Promise<void>;
  isAuthorized: boolean;
  currentPlaybackTime: number;
  currentPlaybackDuration: number;
}

interface MusicKitGlobal {
  configure(opts: { developerToken: string; app: { name: string; build: string } }): Promise<unknown>;
  getInstance(): MusicKitInstance;
}

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

async function loadMusicKit(): Promise<MusicKitGlobal> {
  if (window.MusicKit) return window.MusicKit;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('musickit.js failed to load'));
    document.body.appendChild(script);
  });
  const mk = window.MusicKit;
  if (!mk) throw new Error('MusicKit failed to initialize');
  return mk;
}

async function fetchDeveloperToken(): Promise<string | null> {
  const res = await fetch('/api/apple/dev-token');
  if (res.status === 501) return null;
  if (!res.ok) throw new Error(`dev-token: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

/**
 * Apple Music player adapter implementing IPlayer interface.
 * MusicKit v3 measures time in seconds; we convert to/from milliseconds internally.
 */
class ApplePlayerAdapter implements IPlayer {
  private music: MusicKitInstance;
  private endedCallbacks: Array<() => void> = [];
  private positionCallbacks: Array<(ms: number) => void> = [];
  private positionPollInterval: NodeJS.Timeout | null = null;

  constructor(music: MusicKitInstance) {
    this.music = music;
  }

  async play(): Promise<void> {
    await this.music.play();
  }

  async pause(): Promise<void> {
    await this.music.pause();
  }

  async seekToMs(positionMs: number): Promise<void> {
    const seconds = positionMs / 1000;
    await this.music.seekToTime(seconds);
  }

  async getCurrentPositionMs(): Promise<number> {
    try {
      const seconds = this.music.currentPlaybackTime;
      return Math.round(seconds * 1000);
    } catch {
      return 0;
    }
  }

  async getDurationMs(): Promise<number> {
    try {
      const seconds = this.music.currentPlaybackDuration;
      return Math.round(seconds * 1000);
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

export function ApplePlayer({
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
  const musicRef = useRef<MusicKitInstance | null>(null);
  const adapterRef = useRef<ApplePlayerAdapter | null>(null);
  const [status, setStatus] = useState<'idle' | 'unconfigured' | 'ready' | 'error'>('idle');
  const state = useStore((s) => s.state);
  const nowPlaying = state?.nowPlayingId
    ? state.queue.find((t) => t.id === state.nowPlayingId)
    : undefined;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!features.apple) {
          setStatus('unconfigured');
          return;
        }
        const token = await fetchDeveloperToken();
        if (cancelled) return;
        if (!token) {
          setStatus('unconfigured');
          return;
        }
        const MusicKit = await loadMusicKit();
        await MusicKit.configure({
          developerToken: token,
          app: { name: 'cojam', build: '0.1.0' },
        });
        musicRef.current = MusicKit.getInstance();
        const adapter = new ApplePlayerAdapter(musicRef.current);
        adapterRef.current = adapter;
        onPlayerReady?.(adapter);
        onAuthorized(musicRef.current.isAuthorized);
        setStatus('ready');
      } catch (e) {
        console.error('MusicKit init failed:', e);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      if (adapterRef.current) {
        adapterRef.current.dispose();
        adapterRef.current = null;
        onPlayerGone?.();
      }
    };
  }, [onAuthorized, onPlayerReady, onPlayerGone]);

  useEffect(() => {
    const music = musicRef.current;
    if (!music || !authorized || !nowPlaying) return;
    if (pickSource(nowPlaying, { appleAuthorized: authorized, spotifyAuthorized: false }) !== 'apple') return;
    const songId = nowPlaying.sources.apple!.songId!;
    (async () => {
      try {
        await music.setQueue({ songs: [songId] });
        await music.play();
      } catch (e) {
        console.error('Apple playback failed:', e);
      }
    })();
  }, [authorized, nowPlaying]);

  if (status === 'unconfigured' || status === 'idle') return null;
  if (status === 'error') {
    return (
      <div className="text-sm" style={{ color: '#ef4444' }}>
        Apple Music unavailable
      </div>
    );
  }

  if (!authorized) {
    return (
      <button
        onClick={async () => {
          try {
            await musicRef.current?.authorize();
            onAuthorized(true);
          } catch (e) {
            console.error('Apple authorize failed:', e);
          }
        }}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
        style={{ backgroundColor: 'var(--color-info)', color: 'var(--color-surface-0)' }}
      >
        <AppleMusicIcon size={16} />
        Connect Apple Music
      </button>
    );
  }

  return (
    <div className="text-sm inline-flex items-center gap-2" style={{ color: 'var(--color-text-secondary)' }}>
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--color-info)' }} />
      <span>
        Apple Music connected
        {nowPlaying && pickSource(nowPlaying, { appleAuthorized: true, spotifyAuthorized: false }) === 'apple' && (
          <span style={{ color: 'var(--color-info)' }}> playing &quot;{nowPlaying.title}&quot;</span>
        )}
      </span>
    </div>
  );
}
