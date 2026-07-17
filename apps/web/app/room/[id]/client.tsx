'use client';

import { useState, useEffect, useCallback } from 'react';
import { useStore, joinRoom, setRadio } from '@/lib/realtime';

// Persist the chosen name for the session so a full-page redirect (Spotify OAuth
// returns to /callback/spotify then back here) auto-rejoins instead of dropping
// the user back to the name form. Session-scoped; cleared when the tab closes.
const NAME_KEY = 'mj_room_name';
import { pickSource } from '@/lib/pickSource';
import { features } from '@/lib/features';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { ApplePlayer } from '../components/ApplePlayer';
import { SpotifyPlayer } from '../components/SpotifyPlayer';
import { QueuePanel } from '../components/QueuePanel';
import { AddTrackForm } from '../components/AddTrackForm';
import { PresenceBar } from '../components/PresenceBar';
import { ShareRoomButton } from '../components/ShareRoomButton';
import { OnboardingCard } from '../components/OnboardingCard';
import { TrackDepthPanel } from '../components/TrackDepthPanel';
import { SpotifyIcon, YouTubeIcon, AppleMusicIcon } from '@/app/components/icons';

export function RoomClient({ roomId }: { roomId: string }) {
  const [nameInput, setNameInput] = useState('');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);
  const [appleAuthorized, setAppleAuthorized] = useState(false);
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(false);
  const [trackDepthOpen, setTrackDepthOpen] = useState(false);
  const store = useStore();
  const nowPlaying = store.state?.nowPlayingId
    ? store.state.queue.find((t) => t.id === store.state!.nowPlayingId)
    : undefined;
  const activeSource = nowPlaying
    ? pickSource(nowPlaying, { appleAuthorized, spotifyAuthorized })
    : null;
  const queueEmpty = (store.state?.queue?.length ?? 0) === 0;

  const doJoin = useCallback(
    async (name: string) => {
      setLoading(true);
      try {
        await joinRoom(roomId, name);
        sessionStorage.setItem(NAME_KEY, name);
        setJoined(true);
      } catch (error) {
        console.error('Failed to join:', error);
      } finally {
        setLoading(false);
      }
    },
    [roomId],
  );

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const name = nameInput.trim();
    if (name) doJoin(name);
  };

  // Auto-rejoin after a full-page nav (e.g. Spotify OAuth) using the saved name.
  useEffect(() => {
    if (joined) return;
    const saved = sessionStorage.getItem(NAME_KEY);
    if (saved) doJoin(saved);
  }, [joined, doJoin]);

  if (!joined) {
    return (
      <main id="main" className="room flex items-center justify-center min-h-screen p-4">
        <form
          onSubmit={handleJoin}
          className="panel w-full max-w-sm space-y-6 p-8"
        >
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
              Cojam
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Room: {roomId}
            </p>
          </div>

          <input
            type="text"
            placeholder="Your name"
            aria-label="Your name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            className="w-full px-4 py-3 rounded-lg focus:outline-none transition-all duration-150"
            style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
            autoFocus
          />

          <button
            type="submit"
            disabled={loading || !nameInput.trim()}
            className="w-full px-6 py-3 rounded-lg font-semibold transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 text-base"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
          >
            {loading ? 'Joining...' : 'Join & Play'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="room min-h-screen" style={{ color: 'var(--color-text-primary)' }}>
      <header className="room-header">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="space-y-1 min-w-0">
              <h1 className="text-2xl font-bold">Cojam</h1>
              <p className="text-sm truncate" style={{ color: 'var(--color-text-secondary)' }}>
                Room: {roomId} as {store.name}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <PresenceBar />
              <ShareRoomButton />
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
                <div
                  className="w-2 h-2 rounded-full animate-pulse-breath"
                  style={{ backgroundColor: store.connected ? 'var(--color-accent)' : '#ef4444' }}
                />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {store.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main id="main" className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6 room-arrival" style={{ ['--i' as string]: 0 }}>
            {queueEmpty && <OnboardingCard />}
            <div className="panel p-6 space-y-4">
              <div className="flex flex-wrap gap-2">
                {features.spotify && (
                  <SpotifyPlayer authorized={spotifyAuthorized} onAuthorized={setSpotifyAuthorized} />
                )}
                {features.apple && (
                  <ApplePlayer authorized={appleAuthorized} onAuthorized={setAppleAuthorized} />
                )}
              </div>

              {features.youtube && activeSource === 'youtube' && (
                <div className="pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
                  <YouTubePlayer roomId={roomId} />
                </div>
              )}
            </div>

            {/* Now-Playing Hero */}
            <div className={`panel now-playing p-6 space-y-3${nowPlaying ? ' is-live' : ''}`}>
              <div className="flex items-center justify-end">
                <button
                  onClick={() => setRadio(roomId, !(store.state?.radioEnabled ?? false))}
                  aria-pressed={store.state?.radioEnabled ?? false}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                  style={{
                    background: (store.state?.radioEnabled ?? false) ? 'var(--color-accent)' : 'var(--color-surface-2)',
                    border: '1px solid var(--color-border)',
                    color: (store.state?.radioEnabled ?? false) ? 'var(--color-surface-1)' : 'var(--color-text-primary)',
                  }}
                  title="Auto-plays related songs when the queue runs out"
                >
                  Radio {(store.state?.radioEnabled ?? false) ? 'on' : 'off'}
                </button>
              </div>
              {nowPlaying ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="eq" aria-hidden>
                      <span /><span /><span /><span />
                    </span>
                    <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--color-accent)', letterSpacing: '0.15em' }}>
                      Now playing
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <div key={nowPlaying.id} className="flex-1 min-w-0 track-change-enter">
                      <h2 className="text-2xl font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                        {nowPlaying.title}
                      </h2>
                      <p className="text-sm mt-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                        {nowPlaying.artist}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {activeSource === 'youtube' && (
                        <span className="badge-source badge-youtube inline-flex items-center gap-1">
                          <YouTubeIcon size={14} />
                          YouTube
                        </span>
                      )}
                      {activeSource === 'spotify' && (
                        <span className="badge-source badge-spotify inline-flex items-center gap-1">
                          <SpotifyIcon size={14} />
                          Spotify
                        </span>
                      )}
                      {activeSource === 'apple' && (
                        <span className="badge-source badge-apple inline-flex items-center gap-1">
                          <AppleMusicIcon size={14} />
                          Apple
                        </span>
                      )}
                      {features.trackDepth && nowPlaying && (
                        <button
                          onClick={() => setTrackDepthOpen(true)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                          style={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-primary)',
                          }}
                          title="View track details from MusicBrainz"
                        >
                          Details
                        </button>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="hero-empty">
                  <p style={{ color: 'var(--color-text-secondary)' }}>Nothing playing</p>
                  <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
                    Add a track to get started
                  </p>
                </div>
              )}
            </div>

            <AddTrackForm roomId={roomId} />
          </div>

          <div className="lg:col-span-1 room-arrival" style={{ ['--i' as string]: 1 }}>
            <QueuePanel roomId={roomId} />
          </div>
        </div>
      </main>

      {/* Track Depth Panel */}
      <TrackDepthPanel
        roomId={roomId}
        track={nowPlaying || null}
        open={trackDepthOpen}
        onClose={() => setTrackDepthOpen(false)}
      />
    </div>
  );
}
