'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useStore, joinRoom, nowPlayingAdvance, getClockOffsetMs } from '@/lib/realtime';
import { useDriftCorrection } from '@/lib/useDriftCorrection';
import { StatusBanner } from '../components/StatusBanner';
import { avatarGradient } from '@/lib/avatar';
import { NAME_KEY } from '@/lib/guestName';

// The chosen name is persisted for the session (lib/guestName) so a full-page
// redirect (Spotify OAuth) and the landing's name+create both auto-rejoin
// instead of dropping the user on the name form.

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};
import { pickSource } from '@/lib/pickSource';
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
import { ListenersStage } from '../components/ListenersStage';
import { ShareRoomButton } from '../components/ShareRoomButton';
import { ReportRoomButton } from '../components/ReportRoomButton';
import { PublicRoomToggle } from '../components/PublicRoomToggle';
import { OnboardingCard } from '../components/OnboardingCard';
import { TrackDepthPanel } from '../components/TrackDepthPanel';
import { LyricsPanel } from '../components/LyricsPanel';
import { EnrichmentPanel } from '../components/EnrichmentPanel';
import { NowPlayingCard } from '../components/NowPlayingCard';
import { Stage } from '../components/Stage';
import { LogoMark } from '@/app/components/Logo';
import type { IPlayer } from '@/lib/playerInterface';
import { useTrackColors } from '@/lib/useTrackColor';
import { tintStyle, groundPair } from '@/lib/trackColor';
import { queueArtwork } from '../components/QueuePanel';
import { useMotion } from '@/lib/motionFlags';
import { useCoverFlight } from '@/lib/useCoverFlight';
import { GroundStack } from '@/app/components/GroundStack';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';

type VideoPanelTab = 'playing' | 'queue' | 'chat' | 'add';

// The host-set room label, trimmed. A module-level helper: calling .trim() on a
// store-derived value inside the component makes the React Compiler treat the
// store (and the join callback that reads activeSource) as mutated.
function cleanLabel(label: string | undefined): string {
  return label ? label.trim() : '';
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
  // isUnavailable() is exactly "pickSource() found nothing for this client"
  const trackUnavailable = Boolean(nowPlaying) && activeSource === null;
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
        <GroundStack spec={{ palette: groundPair(tint, palette) }} animate={motion.ground} originSelector={motion.flip ? '.r4-cover' : undefined} />
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
    <div className="r4-player">
      {(f.spotify || f.apple) && (
        <div className="r4-player__connect">
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
      )}

      {!videoMode && f.youtube && activeSource === 'youtube' && (
        <div className="r4-player__yt">
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

  const radioOn = store.state?.radioEnabled ?? false;

  const heroPanel = (
    <NowPlayingCard
      roomId={roomId}
      track={nowPlaying}
      state={trackUnavailable ? 'unavailable' : nowPlaying && playFailedId === nowPlaying.id ? 'failed' : 'ok'}
      artwork={artwork}
      coverLevel={coverLevel}
      onCoverError={() => setCoverFail({ url: artwork, level: coverLevel + 1 })}
      isPlaying={isPlaying}
      transportState={transportState}
      hostControl={hostControl}
      hostLabel={Boolean(f.roomAuth && store.state?.hostUserId && hostControl)}
      activeSource={activeSource}
      activePlayer={activePlayer}
      roomAgeS={roomAgeS}
      radioOn={radioOn}
      onOpenDepth={() => setTrackDepthOpen(true)}
      onOpenLyrics={() => setLyricsOpen(true)}
      onOpenEnrichment={() => setEnrichmentOpen(true)}
    />
  );

  const listenersStage = (
    <ListenersStage roomId={roomId} canControl={hostControl} running={isPlaying} hostUserId={store.state?.hostUserId} />
  );

  const addTrackForm = (
    <AddTrackForm roomId={roomId} spotifyAuthorized={spotifyAuthorized} appleAuthorized={appleAuthorized} />
  );

  // "+ Adicionar música" in the queue header: the phone switches to its Add tab,
  // every width scrolls the add form into view and focuses its search field.
  const goToAdd = () => {
    setPanelTab('add');
    requestAnimationFrame(() => {
      const panel = document.getElementById('video-panel-add');
      if (!panel) return;
      const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      panel.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      panel.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  };

  const queuePanels = (
    <>
      <QueuePanel roomId={roomId} canControl={hostControl} onAdd={goToAdd} />
      <ActivityRail />
    </>
  );
  const chatPanel = f.roomChat ? <ChatPanel roomId={roomId} canControl={hostControl} /> : null;

  const roomName = cleanLabel(store.state?.name);
  const listeners = store.members.length;
  const tabs = (extra: string) => (
    <div className={`video-tabs ${extra}`.trim()} role="tablist" aria-label="Painéis da sala">
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
  );

  return (
    <div
      className="room r4 min-h-screen"
      data-room="r4"
      data-has-track={nowPlaying ? 'true' : 'false'}
      style={{ color: 'var(--color-text-primary)' }}
    >
      <StatusBanner />
      {/* Rebind soft notice (#172): proof verification failed (secret rotation
          or expiry), so guest contributions could not be linked. The room and
          the sign-in keep working; only the attribution handoff is lost. The
          live region stays mounted (empty when there is no notice) so screen
          readers announce the text when it appears. */}
      <p role="status" className="text-xs text-center px-4" style={{ color: 'var(--color-text-muted)' }}>
        {store.rebindNotice}
      </p>
      <header className="room-header r4-header">
        <div className="r4-header__inner">
          <div className="r4-brand">
            <span className="r4-brand__logo">
              {/* Flows only while (re)connecting: colors moving = syncing. */}
              <LogoMark size={48} animated={store.reconnecting || !store.connected} />
              <span className="r4-brand__word">CoJam</span>
            </span>
            <span className="r4-divider" aria-hidden="true" />
            <div className="r4-title">
              <div className="r4-title__row">
                <h1 className="r4-title__name">
                  {roomName ? roomName : (<>Sala <span className="r4-title__code">{roomId}</span></>)}
                </h1>
                {nowPlaying && isPlaying && (
                  <span className="r4-live">
                    <span className="r4-live__dot" aria-hidden="true" />
                    AO VIVO
                  </span>
                )}
                {listeners > 0 && (
                  <span className="r4-count">{listeners === 1 ? '1 ouvindo' : `${listeners} ouvindo junto`}</span>
                )}
              </div>
              <p className="r4-title__sub">
                {roomName && <span className="room-code-chip">{roomId}</span>}
                <span className="truncate" data-testid="room-me">você é {store.name}</span>
                {accountsEnabled && !store.signedIn && <span className="guest-chip">Convidado</span>}
                {/* Directory opt-in is host-only (the server enforces it); non-hosts see nothing. */}
                {hostControl && f.publicRooms && <PublicRoomToggle roomId={roomId} />}
              </p>
            </div>
          </div>
          <div className="r4-actions">
            {(store.reconnecting || !store.connected) && (
              <span className="r4-conn" data-state={store.reconnecting ? 'reconnecting' : 'lost'}>
                <span className="connection-dot" data-state={store.reconnecting ? 'reconnecting' : 'lost'} />
                <span className="r4-conn__text">{store.reconnecting ? 'Reconectando...' : 'Desconectado'}</span>
              </span>
            )}
            <ReportRoomButton roomId={roomId} variant="icon" />
            <ReportRoomButton roomId={roomId} variant="text" />
            <ShareRoomButton />
            {accountsEnabled ? (
              <Link href="/account" className="r4-me" aria-label={`Conta de ${store.name}`} title="Conta" style={{ background: avatarGradient(store.clientId || store.name) }}>
                {store.name.charAt(0).toUpperCase()}
              </Link>
            ) : (
              <span className="r4-me" title={store.name} style={{ background: avatarGradient(store.clientId || store.name) }} aria-hidden="true">
                {store.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="room-main r4-main">
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

            {tabs('')}

            <div data-testid="video-main-column" className="video-main r4-stack">
              {(f.spotify || f.apple) && playerPanel}
              <div id="video-panel-playing" role="tabpanel" aria-labelledby="video-tab-playing" className="video-panel r4-stack" data-active={panelTab === 'playing'}>
                {heroPanel}
                {listenersStage}
              </div>
              <div id="video-panel-add" role="tabpanel" aria-labelledby="video-tab-add" className="video-panel" data-active={panelTab === 'add'}>
                {addTrackForm}
              </div>
            </div>

            <div data-testid="video-side-column" className="video-side r4-stack">
              <div id="video-panel-queue" role="tabpanel" aria-labelledby="video-tab-queue" className="video-panel r4-stack" data-active={panelTab === 'queue'}>
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
            <div className="audio-room r4-grid grid grid-cols-1 md:grid-cols-5" data-testid="audio-room" data-tab={panelTab}>
              <div data-testid="room-main-column" className="r4-main-col md:col-span-3 room-arrival" style={{ ['--i' as string]: 0 }}>
                {/* Below 768px the same Playing / Queue / Chat / Add tabs as the video
                    room (#258) decide which panel shows; md and up shows every panel. */}
                <div id="video-panel-playing" role="tabpanel" aria-labelledby="video-tab-playing" className="video-panel video-panel-keep r4-stack" data-active={panelTab === 'playing'}>
                  {queueEmpty && <OnboardingCard />}
                  <div className="r4-stage r4-stack">
                    {heroPanel}
                    {listenersStage}
                  </div>
                  {playerPanel}
                </div>
              </div>

              <div data-testid="room-side-column" className="r4-side md:col-span-2 room-arrival" style={{ ['--i' as string]: 1 }}>
                <div id="video-panel-queue" role="tabpanel" aria-labelledby="video-tab-queue" className="video-panel r4-queue-col r4-stack" data-active={panelTab === 'queue'}>
                  {queuePanels}
                </div>
                <div id="video-panel-add" role="tabpanel" aria-labelledby="video-tab-add" className="video-panel r4-add-col" data-active={panelTab === 'add'}>
                  {addTrackForm}
                </div>
                {chatPanel && (
                  <div id="video-panel-chat" role="tabpanel" aria-labelledby="video-tab-chat" className="video-panel r4-chat-col" data-active={panelTab === 'chat'}>
                    {chatPanel}
                  </div>
                )}
              </div>
            </div>
            {tabs('audio-tabs')}
          </>
        )}
      </main>

      <footer className="room-footer text-xs text-center px-4 pb-6" style={{ color: 'var(--color-text-muted)' }}>
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
