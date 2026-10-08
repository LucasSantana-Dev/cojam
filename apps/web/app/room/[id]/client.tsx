'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useStore, joinRoom, setRadio, nowPlayingAdvance, getClockOffsetMs } from '@/lib/realtime';
import { useDriftCorrection } from '@/lib/useDriftCorrection';
import { StatusBanner } from '../components/StatusBanner';
import { avatarGradient } from '@/lib/avatar';
import { NAME_KEY } from '@/lib/guestName';

// The chosen name is persisted for the session (lib/guestName) so a full-page
// redirect (Spotify OAuth) and the landing's name+create both auto-rejoin
// instead of dropping the user on the name form.

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};
import { pickSource, isUnavailable } from '@/lib/pickSource';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { canControl } from '@/lib/roomRole';
import { getStoredUserId } from '@/lib/auth';
import { getAccountSession, getConnectedServices, getDisplayName, markServiceConnected } from '@/lib/account';
import { supabaseEnabled } from '@/lib/supabase';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { ApplePlayer } from '../components/ApplePlayer';
import { SpotifyPlayer } from '../components/SpotifyPlayer';
import { QueuePanel } from '../components/QueuePanel';
import { ActivityRail } from '../components/ActivityRail';
import { ChatPanel } from '../components/ChatPanel';
import { AddTrackForm } from '../components/AddTrackForm';
import { PresenceBar } from '../components/PresenceBar';
import { PresenceMeta } from '../components/PresenceMeta';
import { ShareRoomButton } from '../components/ShareRoomButton';
import { ReportRoomButton } from '../components/ReportRoomButton';
import { PublicRoomToggle } from '../components/PublicRoomToggle';
import { OnboardingCard } from '../components/OnboardingCard';
import { TrackDepthPanel } from '../components/TrackDepthPanel';
import { LyricsPanel } from '../components/LyricsPanel';
import { EnrichmentPanel } from '../components/EnrichmentPanel';
import { UnavailableTrack } from '../components/UnavailableTrack';
import { PlayFailedTrack } from '../components/PlayFailedTrack';
import { TransportUI } from '../components/TransportUI';
import { Stage } from '../components/Stage';
import { SpotifyIcon, YouTubeIcon, AppleMusicIcon } from '@/app/components/icons';
import { LogoMark } from '@/app/components/Logo';
import type { IPlayer } from '@/lib/playerInterface';
import { useTrackColors } from '@/lib/useTrackColor';
import { tintStyle, groundPair } from '@/lib/trackColor';
import { ListenersWave } from '@/app/components/ListenersWave';
import { queueArtwork } from '../components/QueuePanel';
import { useMotion } from '@/lib/motionFlags';
import { useCoverFlight } from '@/lib/useCoverFlight';
import { GroundStack } from '@/app/components/GroundStack';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';

type VideoPanelTab = 'playing' | 'queue' | 'chat' | 'add';

// mm:ss for the shared room-age clock on the now-playing card.
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
  // Per-user playback failure: id of the now-playing track this client's
  // provider failed to play, reported by the player adapters. Local-only;
  // never touches transport state or other members.
  const [playFailedId, setPlayFailedId] = useState<string | null>(null);
  const [enrichmentOpen, setEnrichmentOpen] = useState(false);
  // Video rooms below 768px: which panel the tab bar shows under the pinned
  // stage. Ignored at md and up, where every panel is visible.
  const [panelTab, setPanelTab] = useState<VideoPanelTab>('playing');
  // Feature flags resolve at runtime (via /env.js), not build time, so the
  // env-agnostic image can flip any flag. The hook's server snapshot (build-time
  // values) keeps SSR and the first client render in agreement.
  const f = useRuntimeFeatures();
  // Accounts link: resolved at runtime, hydration-safe via the server snapshot.
  const accountsEnabled = useSyncExternalStore(noopSubscribe, supabaseEnabled, () => false);

  // Accounts: when signed in, load persisted connected services into the store
  // (search ranking follows them on any device, even before local OAuth state
  // settles) and prefill the join name from the profile. Guests skip all of this.
  // The signedIn flag drives the guest-identity signals (#167).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await getAccountSession();
      if (cancelled) return;
      useStore.getState().setSignedIn(!!session);
      if (!session) return;
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
  const store = useStore();
  const nowPlaying = store.state?.nowPlayingId
    ? store.state.queue.find((t) => t.id === store.state!.nowPlayingId)
    : undefined;
  const activeSource = nowPlaying
    ? pickSource(nowPlaying, { appleAuthorized, spotifyAuthorized })
    : null;
  const queueEmpty = (store.state?.queue?.length ?? 0) === 0;

  // "Cor da faixa" (#325): the room takes its ground colour from the cover that
  // is playing. The CSS crossfades --tint-l/c/h, so a track change is a colour
  // glide, not a swap. Idle violet when nothing plays.
  const artwork = nowPlaying ? queueArtwork(nowPlaying) : null;
  const { tint, palette } = useTrackColors(artwork);
  const [coverFail, setCoverFail] = useState<{ url: string | null; level: number }>({ url: null, level: 0 });
  const coverLevel = coverFail.url === artwork ? coverFail.level : 0;
  const motion = useMotion();
  useCoverFlight(nowPlaying?.id, motion.flip);

  // Shared room-age clock: RoomState.createdAt is server-stamped, so every
  // client shows the same age once the measured sync.ping offset is applied.
  // Rooms created before timestamps existed carry no createdAt; stay silent
  // rather than show a fake time (honest-data lock).
  const createdAt = store.state?.createdAt;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!joined || !createdAt) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [joined, createdAt]);
  const roomAgeS = createdAt
    ? Math.max(0, Math.floor((nowMs + getClockOffsetMs() - createdAt) / 1000))
    : null;

  // U5: compute room control permission for this user
  const hostControl = canControl({
    roomAuth: f.roomAuth,
    myUserId: getStoredUserId(),
    hostUserId: store.state?.hostUserId,
  });

  // Presence snapshot for the fused now-playing chip lives in PresenceMeta,
  // which reads the store directly (per-connection members, no name dedupe).
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
          error instanceof Error ? error.message : 'Não deu para entrar. Confira o código da sala e tente de novo.'
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

  // U4: Drift correction loop (gated by the sync feature flag). The hook keys
  // off the meaningful transport fields, not publication object identity (#177).
  useDriftCorrection(activePlayer, f.sync);

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
    // Same ground component and surface as the room (sintonia, #325). Before
    // joining the client holds no room state (the room channel is only
    // subscribed by joinRoom), so this is the idle ground: no cover, no member
    // list. The ground sits at the same tree position as in the joined room, so
    // it is not remounted when the visitor enters: the colour carries over.
    const initial = (nameInput.trim() || 'G').charAt(0).toUpperCase();
    return (
      <div
        className="room join-room min-h-screen"
        data-tint="room"
        data-bg="sintonia"
        data-has-track="false"
        style={{ color: 'var(--color-text-primary)', ...tintStyle(tint) }}
      >
        <GroundStack spec={{ palette: groundPair(tint, palette) }} animate={motion.ground} originSelector={motion.flip ? '.np-cover' : undefined} />
        <main id="main" className="join-main">
          <form onSubmit={handleJoin} className="join-form panel">
            <div className="join-brand">
              <LogoMark size={20} /> CoJam
            </div>

            {/* One H1: the framing sentence plus the room code, which stays visible. */}
            <h1 className="join-title">
              <span className="join-eyebrow">Você vai entrar na sala</span>
              <span className="join-code" data-testid="join-room-code">{roomId}</span>
            </h1>
            <p className="join-tagline">Ouçam juntos, entre serviços</p>

            {/* The wave, flat: nobody is here yet to link to. The visitor's own
                avatar sits at the end, waiting until they join. */}
            <div className="join-wave" role="group" aria-label="Você, esperando para entrar">
              <svg className="join-wave__line" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 4">
                <path d="M0 2 H100" fill="none" stroke="oklch(1 0 0)" strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
              <span className="lw-av join-wave__av" style={{ background: avatarGradient(nameInput.trim() || 'guest') }}>
                {initial}
              </span>
              <span className="join-wave__wait">esperando</span>
            </div>

            <input
              type="text"
              placeholder="Seu nome"
              aria-label="Seu nome"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="join-input focus-ring-grow"
              autoComplete="nickname"
              autoFocus
            />

            <button type="submit" disabled={loading || !nameInput.trim()} className="btn-primary join-submit">
              <span className="join-label-crossfade">
                {loading ? 'Entrando...' : 'Entrar na sala'}
              </span>
            </button>

            {/* Guest-identity signal (#167): guests' identity lives in this
                browser's localStorage only. Hidden from signed-in members and
                when accounts are not deployed (no remedy to point at). */}
            {accountsEnabled && !store.signedIn && (
              <p className="join-note">
                Sua identidade fica guardada neste navegador. Entre na sua conta antes de sair
                da sala para manter seu papel em outros dispositivos.
              </p>
            )}

            {/* Error state */}
            {joinError && (
              <p className="join-error" role="alert">
                {joinError}
              </p>
            )}
          </form>
        </main>
      </div>
    );
  }

  // room.kick (#181): the server closed this connection with the terminal
  // kicked code. Replace the room UI entirely — no StatusBanner retry loop,
  // since the disconnect was deliberate and the connection will not retry.
  if (store.kicked) {
    return (
      <SintoniaScreen>
        <main id="main" className="sx-main">
          <div className="sx-glass sx-card sx-card--narrow sx-center">
            <div className="sx-brand">
              <LogoMark size={20} /> CoJam
            </div>
            <h1 className="sx-title sx-title--sm">Você foi removido da sala</h1>
            <SineLine flat />
            <p className="sx-text">O anfitrião removeu você desta sessão.</p>
            <div className="sx-actions sx-actions--center">
              <Link href="/" className="btn-primary">
                Voltar ao início
              </Link>
            </div>
          </div>
        </main>
      </SintoniaScreen>
    );
  }

  // Video rooms (#258): stage + panels, only when the flag is on, the
  // now-playing track is video and this client plays it through YouTube. Every
  // other case (audio track, flag off, Spotify/Apple source) keeps the
  // original two-column layout untouched.
  const videoMode =
    f.video && f.youtube && nowPlaying?.kind === 'video' && activeSource === 'youtube';

  const videoTabs: ReadonlyArray<readonly [VideoPanelTab, string]> = [
    ['playing', 'Tocando'],
    ['queue', 'Fila'],
    ...(f.roomChat ? ([['chat', 'Chat']] as const) : []),
    ['add', 'Adicionar'],
  ];

  const playerPanel = (
            <div className="panel player-panel p-6 space-y-4">
              <div className="flex flex-wrap gap-2">
                {f.spotify && (
                  <SpotifyPlayer
                    authorized={spotifyAuthorized}
                    onAuthorized={setSpotifyAuthorized}
                    onPlayerReady={(player) => activeSource === 'spotify' && setActivePlayer(player)}
                    onPlayerGone={() => activeSource === 'spotify' && setActivePlayer(null)}
                    onPlayError={setPlayFailedId}
                  />
                )}
                {f.apple && (
                  <ApplePlayer
                    authorized={appleAuthorized}
                    onAuthorized={setAppleAuthorized}
                    onPlayerReady={(player) => activeSource === 'apple' && setActivePlayer(player)}
                    onPlayerGone={() => activeSource === 'apple' && setActivePlayer(null)}
                    onPlayError={setPlayFailedId}
                  />
                )}
              </div>

              {!videoMode && f.youtube && activeSource === 'youtube' && (
                <div className="pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
                  <YouTubePlayer
                    roomId={roomId}
                    onPlayerReady={setActivePlayer}
                    onPlayerGone={() => setActivePlayer(null)}
                    onPlayError={setPlayFailedId}
                  />
                </div>
              )}
            </div>
  );

  const heroPanel = (
            <div className={`panel now-playing np-stage p-6 space-y-4${nowPlaying && isPlaying ? ' is-live' : ''}`}>
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
                      ? 'Tocando agora'
                      : transportState === 'stopped'
                        ? 'Parado'
                        : 'Pausado'}
                  </span>
                  {f.roomAuth && store.state?.hostUserId && hostControl && (
                    <span className="host-chip">Anfitrião</span>
                  )}
                </div>
                <label className="radio-control cursor-pointer" title="Toca músicas parecidas quando a fila acaba">
                  <input
                    type="checkbox"
                    checked={store.state?.radioEnabled ?? false}
                    onChange={(e) => setRadio(roomId, e.target.checked)}
                    className="sr-only"
                  />
                  <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>Rádio</span>
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
              ) : nowPlaying && playFailedId === nowPlaying.id ? (
                <PlayFailedTrack />
              ) : nowPlaying ? (
                <>
                  <div className="np-stage__row">
                  <div className="np-cover" aria-hidden>
                    {artwork && coverLevel < 2 ? (
                      // eslint-disable-next-line @next/next/no-img-element -- cover colour is read from this exact image; crossOrigin keeps the canvas untainted
                      <img
                        key={`${artwork}|${coverLevel}`}
                        src={artwork}
                        alt=""
                        crossOrigin={coverLevel === 0 ? 'anonymous' : undefined}
                        className="np-cover__img"
                        // CORS load failed: show the plain (non-CORS) image, the ground stays idle; if that fails too, the placeholder
                        onError={() => setCoverFail({ url: artwork, level: coverLevel + 1 })}
                      />
                    ) : (
                      <span className="np-cover__fallback">{nowPlaying.title.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="np-stage__text">
                  <div className="np-head flex items-start justify-between gap-4">
                    <div key={nowPlaying.id} className="flex-1 min-w-0 track-change-enter">
                      <h2 className="np-title text-2xl font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                        {nowPlaying.title}
                      </h2>
                      <p className="text-sm mt-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                        {nowPlaying.artist}
                      </p>
                      {/* Fused presence + provenance (R7 + R1): the room's social
                          state lives on the player, not siloed in the header. */}
                      <div className="np-meta">
                        <PresenceMeta />
                        <span>adicionada por {nowPlaying.addedBy}</span>
                        {roomAgeS !== null && (
                          <span className="np-timer">na sala há {formatElapsed(roomAgeS)}</span>
                        )}
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
                      {f.trackDepth && nowPlaying && (
                        <button
                          onClick={() => setTrackDepthOpen(true)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                          style={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-primary)',
                          }}
                          title="Ver detalhes da faixa no MusicBrainz"
                        >
                          Detalhes
                        </button>
                      )}
                      {f.lyrics && nowPlaying && (
                        <button
                          onClick={() => setLyricsOpen(true)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                          style={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-primary)',
                          }}
                          title="Ver a letra desta faixa"
                        >
                          Letra
                        </button>
                      )}
                      {(f.listenBrainz || f.lastfmEnrich) && nowPlaying && (
                        <button
                          onClick={() => setEnrichmentOpen(true)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none"
                          style={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text-primary)',
                          }}
                          title="Ver dados extras do ListenBrainz e do Last.fm"
                        >
                          Mais
                        </button>
                      )}
                    </div>
                  </div>

                  {f.sync && (
                    <div className="np-transport" style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
                      <TransportUI roomId={roomId} activePlayer={activePlayer} canControl={hostControl} />
                    </div>
                  )}
                  {store.members.length > 0 && (
                    <ListenersWave
                      members={store.members.map((m) => ({ id: m.clientId, name: m.name }))}
                      running={isPlaying}
                      animate={motion.ground}
                      getOffsetMs={getClockOffsetMs}
                      className="np-wave"
                    />
                  )}
                  </div>
                  </div>
                </>
              ) : (
                <div className="hero-empty">
                  <p className="text-lg font-medium" style={{ color: 'var(--color-text-primary)' }}>Nada tocando ainda</p>
                  <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
                    Adicione uma faixa abaixo para começar a sessão.
                  </p>
                </div>
              )}
            </div>
  );

  const addTrackForm = (
    <AddTrackForm roomId={roomId} spotifyAuthorized={spotifyAuthorized} appleAuthorized={appleAuthorized} />
  );

  const queuePanels = (
    <>
      <QueuePanel roomId={roomId} canControl={hostControl} />
      <ActivityRail />
    </>
  );
  const chatPanel = f.roomChat ? <ChatPanel roomId={roomId} canControl={hostControl} /> : null;

  return (
    <div
      className="room min-h-screen"
      data-tint="room"
      data-bg="sintonia"
      data-has-track={nowPlaying ? 'true' : 'false'}
      style={{ color: 'var(--color-text-primary)', ...tintStyle(tint) }}
    >
      <GroundStack spec={{ palette: groundPair(tint, palette) }} animate={motion.ground} originSelector={motion.flip ? '.np-cover' : undefined} />
      <StatusBanner />
      {/* Rebind soft notice (#172): proof verification failed (secret rotation
          or expiry), so guest contributions could not be linked. The room and
          the sign-in keep working; only the attribution handoff is lost. The
          live region stays mounted (empty when there is no notice) so screen
          readers announce the text when it appears. */}
      <p role="status" className="text-xs text-center px-4 py-2" style={{ color: 'var(--color-text-muted)' }}>
        {store.rebindNotice}
      </p>
      <header className="room-header">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-2 md:py-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 md:gap-y-3">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold inline-flex items-center gap-2">
                  {/* Flows only while (re)connecting: colors moving = syncing. */}
                  <LogoMark size={20} animated={store.reconnecting || !store.connected} /> CoJam
                </h1>
                <ReportRoomButton roomId={roomId} variant="icon" />
              </div>
              <p className="text-sm flex items-center gap-2 flex-wrap" style={{ color: 'var(--color-text-secondary)' }}>
                <span>Sala</span>
                <span className="room-code-chip">{roomId}</span>
                <span aria-hidden style={{ opacity: 0.5 }}>·</span>
                <span className="truncate" data-testid="room-me">você é {store.name}</span>
                {accountsEnabled && !store.signedIn && <span className="guest-chip">Convidado</span>}
              </p>
            </div>
            <div className="room-header-controls flex items-center gap-2 md:gap-3 flex-wrap">
              <PresenceBar roomId={roomId} canControl={hostControl} />
              <ShareRoomButton />
              <ReportRoomButton roomId={roomId} variant="text" />
              {/* Directory opt-in is host-only (the server enforces it); non-hosts see nothing. */}
              {hostControl && f.publicRooms && <PublicRoomToggle roomId={roomId} />}
              {accountsEnabled && (
                <Link
                  href="/account"
                  className="text-sm underline"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Conta
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
                <span className="text-xs font-medium sr-only md:not-sr-only" style={{ color: 'var(--color-text-secondary)' }}>
                  {store.reconnecting
                    ? 'Reconectando...'
                    : store.connected
                      ? 'Conectado'
                      : 'Desconectado'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main id="main" className="room-main max-w-7xl mx-auto px-4 md:px-6 py-4 md:py-8">
        {/* Switching between a video and an audio track changes layouts and remounts
            the YouTube player once (accepted: tracks rarely alternate mid-session). */}
        {videoMode ? (
          <div className="video-room" data-testid="video-room" data-tab={panelTab}>
            <Stage
              label="Palco de vídeo"
              caption={
                nowPlaying && (
                  <div className="min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                      {nowPlaying.title}
                    </div>
                    <div className="text-xs truncate">de {nowPlaying.artist}</div>
                  </div>
                )
              }
            >
              <YouTubePlayer
                roomId={roomId}
                fill
                onPlayerReady={setActivePlayer}
                onPlayerGone={() => setActivePlayer(null)}
                onPlayError={setPlayFailedId}
              />
            </Stage>

            <div className="video-tabs" role="tablist" aria-label="Painéis da sala">
              {videoTabs.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`video-tab-${id}`}
                  aria-selected={panelTab === id}
                  aria-controls={`video-panel-${id}`}
                  className="video-tab"
                  onClick={() => setPanelTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div data-testid="video-main-column" className="video-main space-y-6">
              {(f.spotify || f.apple) && playerPanel}
              <div id="video-panel-playing" role="tabpanel" aria-labelledby="video-tab-playing" className="video-panel" data-active={panelTab === 'playing'}>
                {heroPanel}
              </div>
              <div id="video-panel-add" role="tabpanel" aria-labelledby="video-tab-add" className="video-panel" data-active={panelTab === 'add'}>
                {addTrackForm}
              </div>
            </div>

            <div data-testid="video-side-column" className="video-side">
              <div id="video-panel-queue" role="tabpanel" aria-labelledby="video-tab-queue" className="video-panel" data-active={panelTab === 'queue'}>
                {queuePanels}
              </div>
              {chatPanel && (
                <div id="video-panel-chat" role="tabpanel" aria-labelledby="video-tab-chat" className="video-panel" data-active={panelTab === 'chat'}>
                  {chatPanel}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
          <div className="audio-room grid grid-cols-1 md:grid-cols-5 lg:grid-cols-3 gap-4 md:gap-8" data-testid="audio-room" data-tab={panelTab}>
          <div data-testid="room-main-column" className="md:col-span-3 lg:col-span-2 space-y-6 room-arrival" style={{ ['--i' as string]: 0 }}>
            {/* Below 768px the same Playing / Queue / Chat / Add tabs as the video
                room (#258) decide which panel shows; md and up shows every panel. */}
            <div id="video-panel-playing" role="tabpanel" aria-labelledby="video-tab-playing" className="video-panel video-panel-keep space-y-6" data-active={panelTab === 'playing'}>
              {queueEmpty && <OnboardingCard />}
              {playerPanel}
              {heroPanel}
            </div>
            <div id="video-panel-add" role="tabpanel" aria-labelledby="video-tab-add" className="video-panel" data-active={panelTab === 'add'}>
              {addTrackForm}
            </div>
          </div>

          <div data-testid="room-side-column" className="md:col-span-2 lg:col-span-1 room-arrival md:sticky md:top-24 md:self-start" style={{ ['--i' as string]: 1 }}>
            <div id="video-panel-queue" role="tabpanel" aria-labelledby="video-tab-queue" className="video-panel" data-active={panelTab === 'queue'}>
              {queuePanels}
            </div>
            {chatPanel && (
              <div id="video-panel-chat" role="tabpanel" aria-labelledby="video-tab-chat" className="video-panel" data-active={panelTab === 'chat'}>
                {chatPanel}
              </div>
            )}
          </div>
        </div>
          <div className="video-tabs audio-tabs" role="tablist" aria-label="Painéis da sala">
            {videoTabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`video-tab-${id}`}
                aria-selected={panelTab === id}
                aria-controls={`video-panel-${id}`}
                className="video-tab"
                onClick={() => setPanelTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          </>
        )}
      </main>

      <footer className="text-xs text-center px-4 pb-6" style={{ color: 'var(--color-text-muted)' }}>
        <Link href="/privacidade" className="underline">Privacidade</Link>
        {' · '}
        <Link href="/termos" className="underline">Termos</Link>
      </footer>

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
