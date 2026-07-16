'use client';

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/realtime';
import { pickSource } from '@/lib/pickSource';
import { features } from '@/lib/features';

declare global {
  interface Window {
    MusicKit: any;
  }
}

async function loadMusicKit(): Promise<any> {
  if (window.MusicKit) return window.MusicKit;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('musickit.js failed to load'));
    document.body.appendChild(script);
  });
  return window.MusicKit;
}

async function fetchDeveloperToken(): Promise<string | null> {
  const res = await fetch('/api/apple/dev-token');
  if (res.status === 501) return null;
  if (!res.ok) throw new Error(`dev-token: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

export function ApplePlayer({
  authorized,
  onAuthorized,
}: {
  authorized: boolean;
  onAuthorized: (v: boolean) => void;
}) {
  const musicRef = useRef<any>(null);
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
          app: { name: 'music-jam', build: '0.1.0' },
        });
        musicRef.current = MusicKit.getInstance();
        onAuthorized(musicRef.current.isAuthorized);
        setStatus('ready');
      } catch (e) {
        console.error('MusicKit init failed:', e);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onAuthorized]);

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
            await musicRef.current.authorize();
            onAuthorized(true);
          } catch (e) {
            console.error('Apple authorize failed:', e);
          }
        }}
        name="Connect Apple Music"
        className="px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
        style={{ backgroundColor: 'var(--color-info)', color: 'var(--color-surface-0)' }}
      >
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
          <span style={{ color: 'var(--color-info)' }}> playing "{nowPlaying.title}"</span>
        )}
      </span>
    </div>
  );
}
