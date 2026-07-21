'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useStore, joinRoom, setRadio, transportPlay, transportPause, getClockOffsetMs, nowPlayingAdvance } from '@/lib/realtime';
import { computeExpectedPosition, shouldCorrect, DRIFT_THRESHOLD_MS, serverNow } from '@/lib/playbackSync';
import { StatusBanner } from '../components/StatusBanner';
import { avatarGradient } from '@/lib/avatar';

// Persist the chosen name for the session so a full-page redirect (Spotify OAuth
// returns to /callback/spotify then back here) auto-rejoins instead of dropping
// the user back to the name form. Session-scoped; cleared when the tab closes.
const NAME_KEY = 'mj_room_name';

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};
import { pickSource, isUnavailable } from '@/lib/pickSource';
import { features } from '@/lib/features';
import { getRuntimeEnv } from '@/lib/runtimeEnv';
import { canControl } from '@/lib/roomRole';
import { getStoredUserId } from '@/lib/auth';
import { getAccountSession, getConnectedServices, getDisplayName, markServiceConnected } from '@/lib/account';
import { supabaseEnabled } from '@/lib/supabase';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { ApplePlayer } from '../components/ApplePlayer';
import { SpotifyPlayer } from '../components/SpotifyPlayer';
import { QueuePanel } from '../components/QueuePanel';
import { AddTrackForm } from '../components/AddTrackForm';
import { PresenceBar } from '../components/PresenceBar';
import { ShareRoomButton } from '../components/ShareRoomButton';
import { OnboardingCard } from '../components/OnboardingCard';
import { TrackDepthPanel } from '../components/TrackDepthPanel';
import { LyricsPanel } from '../components/LyricsPanel';
import { EnrichmentPanel } from '../components/EnrichmentPanel';
import { UnavailableTrack } from '../components/UnavailableTrack';
import { TransportUI } from '../components/TransportUI';
import { SpotifyIcon, YouTubeIcon, AppleMusicIcon } from '@/app/components/icons';
import { LogoMark } from '@/app/components/Logo';
import type { IPlayer } from '@/lib/playerInterface';

// mm:ss for the per-client "in room" clock on the now-playing card.
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RoomClient({ roomId }: { roomId: string }) {
  const [nameInput, setNameInput] = useState('');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [appleAuthorized, setAppleAuthorized] = useState(false);
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(false);
  const [trackDepthOpen, setTrackDepthOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [activePlayer, setActivePlayer] = useState<IPlayer | null>(null);
  const [enrichmentOpen, setEnrichmentOpen] = useState(false);
  // Spotify enable is resolved at runtime (via /env.js), not build time, so the
  // env-agnostic image can turn it on. The server snapshot (build-time value)
  // keeps SSR and the first client render in agreement.
  const spotifyEnabled = useSyncExternalStore(
    noopSubscribe,
    () => getRuntimeEnv()?.spotifyEnabled ?? features.spotify,
    () => features.spotify,
  );
  // Accounts link: resolved at runtime, hydration-safe via the server snapshot.
  const accountsEnabled = useSyncExternalStore(noopSubscribe, supabaseEnabled, () => false);

  // Accounts: when signed in, load persisted connected services into the store
  // (search ranking follows them on any device, even before local OAuth state
  // settles) and prefill the join name from the profile. Guests skip all of this.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await getAccountSession();
      if (!session || cancelled) return;
      const [services, displayName] = await Promise.all([getConnectedServices(), getDisplayName()]);
      if (cancelled) return;
      useStore.getState().setConnectedServices(services);
      if (displayName) setNameInput((prev) => prev || displayName);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Remember the Spotify connection on the account (fact only, never tokens).
  // No-op when signed out.
  useEffect(() => {
    if (spotifyAuthorized) {
      markServiceConnected('spotify').catch((err) => {
        console.warn('[account] persist spotify connection failed', err);
      });
    }
  }, [spotifyAuthorized]);
  // Same for Apple Music.
  useEffect(() => {
    if (appleAuthorized) {
      markServiceConnected('apple').catch((err) => {
        console.warn('[account] persist apple connection failed', err);
      });
    }
  }, [appleAuthorized]);
  const driftCorrectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const store = useStore();
  const nowPlaying = store.state?.nowPlayingId
    ? store.state.queue.find((t) => t.id === store.state!.nowPlayingId)
    : undefined;
  const activeSource = nowPlaying
    ? pickSource(nowPlaying, { appleAuthorized, spotifyAuthorized })
    : null;
  const queueEmpty = (store.state?.queue?.length ?? 0) === 0;

  // Per-client "in room" clock (honest: elapsed since this tab joined).
  const [roomElapsedS, setRoomElapsedS] = useState(0);
  useEffect(() => {
    if (!joined) return;
    const startedAt = Date.now();
    const id = setInterval(() => setRoomElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [joined]);

  // U5: compute room control permission for this user
  const hostControl = canControl({
    roomAuth: features.roomAuth,
    myUserId: getStoredUserId(),
    hostUserId: store.state?.hostUserId,
  });

  // Presence snapshot for the fused now-playing chip. Deduped by name (like
  // PresenceBar) so one person with two tabs counts once.
  const members = store.members ?? [];
  const presenceNames = new Set<string>();
  const presence = members.filter((m) => {
    if (presenceNames.has(m.name)) return false;
    presenceNames.add(m.name);
    return true;
  });
  const presenceStack = presence.slice(0, 4);
  const transportState = store.state?.transport?.state;
  const isPlaying = transportState === 'playing';

  const doJoin = useCallback(
    async (name: string) => {
      setLoading(true);
      setJoinError('');
      try {
        // Compute initial platform from the current active source if available
        const initialPlatform = activeSource;
        await joinRoom(roomId, name, initialPlatform);
        sessionStorage.setItem(NAME_KEY, name);
        setJoined(true);
      } catch (error) {
        console.error('Failed to join:', error);
        setJoinError(
          error instanceof Error ? error.message : 'Couldn\'t join. Check the room code and try again.'
        );
      } finally {
        setLoading(false);
      }
    },
    [roomId, activeSource],
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync of external sessionStorage state into a connection side effect (join) on mount, not a render-driven state update
    if (saved) doJoin(saved);
  }, [joined, doJoin]);

  // U4: Drift correction loop (gated by features.sync)
  // Monitors transport state and corrects playback position drift.
  useEffect(() => {
    if (!features.sync || !activePlayer || !store.state?.transport) return;

    const transport = store.state.transport;

    // Handle state transitions: play/pause/stop
    if (transport.state === 'playing') {
      activePlayer.play().catch((err) => {
        console.warn('Failed to play:', err);
      });
      // Seek to expected position to sync with server
      const expected = computeExpectedPosition(transport, serverNow());
      activePlayer.seekToMs(expected).catch((err) => {
        if (activePlayer.canSeek()) {
          console.warn('Failed to seek to expected position:', err);
        }
        // If !canSeek (e.g. Spotify free tier), silently continue
      });
    } else if (transport.state === 'paused') {
      activePlayer.pause().catch((err) => {
        console.warn('Failed to pause:', err);
      });
    }

    // If playing and the player supports seek, set up drift correction loop
    if (transport.state !== 'playing' || !activePlayer.canSeek()) {
      // Clean up any existing interval
      if (driftCorrectionIntervalRef.current) {
        clearInterval(driftCorrectionIntervalRef.current);
        driftCorrectionIntervalRef.current = null;
      }
      return;
    }

    // Start drift correction interval: check ~every 1500ms
    driftCorrectionIntervalRef.current = setInterval(() => {
      // Re-check state in case it changed
      if (!activePlayer || !store.state?.transport || store.state.transport.state !== 'playing') {
        if (driftCorrectionIntervalRef.current) {
          clearInterval(driftCorrectionIntervalRef.current);
          driftCorrectionIntervalRef.current = null;
        }
        return;
      }

      const transport = store.state.transport;
      const expected = computeExpectedPosition(transport, serverNow());

      activePlayer.getCurrentPositionMs()
        .then((actual) => {
          const drift = actual - expected;
          if (shouldCorrect(drift, DRIFT_THRESHOLD_MS)) {
            activePlayer.seekToMs(expected).catch((err) => {
              console.warn('Drift correction seek failed:', err);
            });
          }
        })
        .catch((err) => {
          console.warn('Failed to get current position for drift check:', err);
        });
    }, 1500);

    return () => {
      if (driftCorrectionIntervalRef.current) {
        clearInterval(driftCorrectionIntervalRef.current);
        driftCorrectionIntervalRef.current = null;
      }
    };
  }, [activePlayer, store.state?.transport, store.state?.transport?.state]);

  // Auto-advance at track end for Spotify/Apple (YouTube also advances via its
  // native onStateChange; the server dedups through AdvanceAfter). onEnded has
  // no unsubscribe, so track the subscribed adapter instance and never
  // double-subscribe the same one.
  const advanceSubscribedRef = useRef<IPlayer | null>(null);
  useEffect(() => {
    if (!activePlayer || advanceSubscribedRef.current === activePlayer) return;
    advanceSubscribedRef.current = activePlayer;
    activePlayer.onEnded(() => {
      const id = useStore.getState().state?.nowPlayingId;
      if (id) nowPlayingAdvance(roomId, id);
    });
  }, [activePlayer, roomId]);

  if (!joined) {
    return (
      <main id="main" className="room flex items-center justify-center min-h-screen p-4">
        <form
          onSubmit={handleJoin}
          className="join-form panel w-full max-w-sm space-y-8 p-8"
        >
          {/* Framing: "You're about to join <CODE>" */}
          <div className="space-y-3 text-center">
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              You&rsquo;re about to join
            </p>
            <div
              className="inline-block px-4 py-2 rounded-full font-bold text-lg"
              style={{
                background: 'var(--color-surface-2)',
                border: '2px solid var(--color-accent)',
                color: 'var(--color-accent)',
              }}
            >
              {roomId}
            </div>
            <p className="text-xs pt-2" style={{ color: 'var(--color-text-muted)' }}>
              Listen together, across services
            </p>
          </div>

          {/* Avatar preview + name input */}
          <div className="space-y-4">
            <div className="flex justify-center">
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-3xl font-bold transition-all duration-200"
                style={{
                  background: avatarGradient(nameInput.trim() || 'guest'),
                  color: 'white',
                  textShadow: '0 2px 4px rgba(0,0,0,0.2)',
                }}
              >
                {(nameInput.trim() || 'G').charAt(0).toUpperCase()}
              </div>
            </div>

            <input
              type="text"
              placeholder="Your name"
              aria-label="Your name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="focus-ring-grow w-full px-4 py-3 rounded-lg focus:outline-none transition-all duration-150 text-center"
              style={{
                backgroundColor: 'var(--color-surface-2)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
              autoFocus
            />
          </div>

          {/* Prominent Join CTA */}
          <button
            type="submit"
            disabled={loading || !nameInput.trim()}
            className="w-full px-6 py-4 rounded-lg font-semibold transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 text-base"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
          >
            <span className="join-label-crossfade">
              {loading ? 'Joining...' : 'Join & Play'}
            </span>
          </button>

          {/* Error state */}
          {joinError && (
            <p className="join-error" role="alert">
              {joinError}
            </p>
          )}
        </form>
      </main>
    );
  }

  return (
    <div className="room min-h-screen" style={{ color: 'var(--color-text-primary)' }}>
      <StatusBanner />
      <header className="room-header">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="space-y-1 min-w-0">
              <h1 className="text-2xl font-bold inline-flex items-center gap-2">
                {/* Flows only while (re)connecting: colors moving = syncing. */}
                <LogoMark size={20} animated={store.reconnecting || !store.connected} /> CoJam
              </h1>
              <p className="text-sm flex items-center gap-2 flex-wrap" style={{ color: 'var(--color-text-secondary)' }}>
                <span>Room</span>
                <span className="room-code-chip">{roomId}</span>
                <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                <span className="truncate">you&rsquo;re {store.name}</span>
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <PresenceBar />
              <ShareRoomButton />
              {accountsEnabled && (
                <Link
                  href="/account"
                  className="text-sm underline"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Account
                </Link>
              )}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
                <div
                  className="connection-dot"
                  data-state={store.reconnecting ? 'reconnecting' : store.connected ? 'connected' : 'lost'}
                  style={{
                    backgroundColor: store.reconnecting
                      ? 'var(--color-status-warn)'
                      : store.connected
                        ? 'var(--color-accent)'
                        : 'var(--color-status-error)',
                    animation: (store.reconnecting || store.connected)
                      ? 'pulse-breath 1s cubic-bezier(0.4, 0, 0.6, 1) infinite'
                      : 'none',
                  }}
                />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {store.reconnecting
                    ? 'Reconnecting...'
                    : store.connected
                      ? 'Connected'
                      : 'Disconnected'}
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
                {spotifyEnabled && (
                  <SpotifyPlayer
                    authorized={spotifyAuthorized}
                    onAuthorized={setSpotifyAuthorized}
                    onPlayerReady={(player) => activeSource === 'spotify' && setActivePlayer(player)}
                    onPlayerGone={() => activeSource === 'spotify' && setActivePlayer(null)}
                  />
                )}
                {features.apple && (
                  <ApplePlayer
                    authorized={appleAuthorized}
                    onAuthorized={setAppleAuthorized}
                    onPlayerReady={(player) => activeSource === 'apple' && setActivePlayer(player)}
                    onPlayerGone={() => activeSource === 'apple' && setActivePlayer(null)}
                  />
                )}
              </div>

              {features.youtube && activeSource === 'youtube' && (
                <div className="pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
                  <YouTubePlayer
                    roomId={roomId}
                    onPlayerReady={setActivePlayer}
                    onPlayerGone={() => setActivePlayer(null)}
                  />
                </div>
              )}
            </div>

            {/* Now-Playing Hero */}
            <div className={`panel now-playing p-6 space-y-4${nowPlaying && isPlaying ? ' is-live' : ''}`}>
              {/* Header row: section label anchors the left, Radio control the right,
                  so the toggle never floats alone above an empty panel. Eq + accent
                  render only while actually playing; paused/stopped say so (R6). */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {nowPlaying && isPlaying && (
                    <span className="eq" aria-hidden>
                      <span /><span /><span /><span />
                    </span>
                  )}
                  <span
                    className="text-xs font-medium uppercase tracking-wider"
                    style={{
                      color: nowPlaying && isPlaying ? 'var(--color-accent)' : 'var(--color-text-muted)',
                      letterSpacing: '0.15em',
                    }}
                  >
                    {!nowPlaying || isPlaying
                      ? 'Now playing'
                      : transportState === 'stopped'
                        ? 'Stopped'
                        : 'Paused'}
                  </span>
                </div>
                <label className="radio-control cursor-pointer" title="Auto-plays related songs when the queue runs out">
                  <input
                    type="checkbox"
                    checked={store.state?.radioEnabled ?? false}
                    onChange={(e) => setRadio(roomId, e.target.checked)}
                    className="sr-only"
                  />
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>Radio</span>
                  <div
                    className="radio-toggle relative w-8 h-4 rounded-full transition-colors duration-150"
                    style={{
                      background: (store.state?.radioEnabled ?? false) ? 'var(--color-accent)' : 'var(--color-surface-3)',
                    }}
                  >
                    <div
                      className="radio-toggle-thumb absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white"
                      style={{
                        transform: (store.state?.radioEnabled ?? false) ? 'translateX(100%)' : 'translateX(0)',
                      }}
                    />
                  </div>
                </label>
              </div>
              {nowPlaying && isUnavailable(nowPlaying, { appleAuthorized, spotifyAuthorized }) ? (
                <UnavailableTrack />
              ) : nowPlaying ? (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <div key={nowPlaying.id} className="flex-1 min-w-0 track-change-enter">
                      <h2 className="text-2xl font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                        {nowPlaying.title}
                      </h2>
                      <p className="text-sm mt-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                        {nowPlaying.artist}
                      </p>
                      {/* Fused presence + provenance (R7 + R1): the room's social
                          state lives on the player, not siloed in the header. */}
                      <div className="np-meta">
                        {features.presence && presence.length > 0 && (
                          <>
                            <span className="presence-stack presence-stack--sm" aria-hidden>
                              {presenceStack.map((m) => (
                                <span
                                  key={m.clientId}
                                  className="avatar-chip"
                                  style={{ background: avatarGradient(m.clientId || m.name) }}
                                >
                                  {m.name.charAt(0).toUpperCase()}
                                </span>
                              ))}
                            </span>
                            <span>{presence.length === 1 ? '1 listening' : `${presence.length} listening`}</span>
                            <span aria-hidden className="np-meta__dot">·</span>
                          </>
                        )}
                        <span>added by {nowPlaying.addedBy}</span>
                        <span className="np-timer">in room {formatElapsed(roomElapsedS)}</span>
                      </div>
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
                      {features.lyrics && nowPlaying && (
                        <button
                          onClick={() => setLyricsOpen(true)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                          style={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-primary)',
                          }}
                          title="View lyrics for this track"
                        >
                          Lyrics
                        </button>
                      )}
                      {(features.listenBrainz || features.lastfmEnrich) && nowPlaying && (
                        <button
                          onClick={() => setEnrichmentOpen(true)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                          style={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-primary)',
                          }}
                          title="View track enrichment from ListenBrainz and Last.fm"
                        >
                          More
                        </button>
                      )}
                    </div>
                  </div>

                  {features.sync && (
                    <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
                      <TransportUI roomId={roomId} activePlayer={activePlayer} canControl={hostControl} />
                    </div>
                  )}
                </>
              ) : (
                <div className="hero-empty">
                  <p className="text-lg font-medium" style={{ color: 'var(--color-text-primary)' }}>Nothing playing yet</p>
                  <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
                    Add a track below to start the session.
                  </p>
                </div>
              )}
            </div>

            <AddTrackForm roomId={roomId} spotifyAuthorized={spotifyAuthorized} appleAuthorized={appleAuthorized} />
          </div>

          <div className="lg:col-span-1 room-arrival lg:sticky lg:top-24 lg:self-start" style={{ ['--i' as string]: 1 }}>
            <QueuePanel roomId={roomId} canControl={hostControl} />
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
      <LyricsPanel
        roomId={roomId}
        track={nowPlaying || null}
        open={lyricsOpen}
        onClose={() => setLyricsOpen(false)}
        activePlayer={activePlayer}
      />
      <EnrichmentPanel
        roomId={roomId}
        track={nowPlaying || null}
        open={enrichmentOpen}
        onClose={() => setEnrichmentOpen(false)}
      />
    </div>
  );
}
