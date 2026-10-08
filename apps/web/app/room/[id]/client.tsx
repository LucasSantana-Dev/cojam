'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useStore, useMyUserId, joinRoom, nowPlayingAdvance, getClockOffsetMs, updatePlatform } from '@/lib/realtime';
import { useDriftCorrection } from '@/lib/useDriftCorrection';
import { StatusBanner } from '../components/StatusBanner';
import { avatarGradient } from '@/lib/avatar';
import { NAME_KEY } from '@/lib/guestName';

// The chosen name is persisted for the session (lib/guestName) so a full-page
// redirect (Spotify OAuth) and the landing's name+create both auto-rejoin
// instead of dropping the user on the name form.

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};
import { resolveSource, listeningPlatform } from '@/lib/pickSource';
import { useListeningService, setListeningService } from '@/lib/listeningService';
import { beginAuth } from '@/lib/spotifyAuth';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { canControl } from '@/lib/roomRole';
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
import { VolumeControl } from '../components/VolumeControl';
import { useApplyVolume } from '@/lib/volume';
import { ListeningServicePicker } from '../components/ListeningServicePicker';
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
  // The Spotify and Apple adapters outlive a switch to another service: keep
  // them so switching back hands drift correction the right player again.
  const spotifyAdapterRef = useRef<IPlayer | null>(null);
  const appleAdapterRef = useRef<IPlayer | null>(null);
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
  // "Ouvir no": the person's service choice. An explicit choice wins when it
  // can play this track; otherwise the auto order applies and fellBack says so.
  const preference = useListeningService();
  const pickOpts = { appleAuthorized, spotifyAuthorized, preference };
  const resolved = nowPlaying ? resolveSource(nowPlaying, pickOpts) : { source: null, fellBack: false, reason: null };
  const activeSource = resolved.source;
  // The presence badge: the service this person listens through, track-independent.
  const platform = listeningPlatform(pickOpts);
  // Keep the badge in step with the choice (and with Spotify/Apple finishing
  // their authorization after the join): reconnects with fresh ConnInfo only on
  // an actual change.
  // doJoin reads it through a ref so a late authorization never re-triggers the
  // auto-rejoin effect (that would join twice).
  const activeSourceRef = useRef(activeSource);
  useEffect(() => {
    activeSourceRef.current = activeSource;
  }, [activeSource]);
  const platformRef = useRef(platform);
  useEffect(() => {
    platformRef.current = platform;
  }, [platform]);
  // Tell the room which service we listen through. Sent after the join settles
  // and again on a change; it never reconnects, so the host keeps the role.
  useEffect(() => {
    if (joined) updatePlatform(roomId, platform);
  }, [joined, roomId, platform]);
  // isUnavailable() is exactly "pickSource() found nothing for this client"
  const trackUnavailable = Boolean(nowPlaying) && activeSource === null;
  const queueEmpty = (store.state?.queue?.length ?? 0) === 0;

  // The cover of the playing track. Its colours only tint the pre-join ground
  // (idle violet while no room state exists); once joined nothing reads them, so
  // the extraction is skipped.
  const artwork = nowPlaying ? queueArtwork(nowPlaying) : null;
  const { tint, palette } = useTrackColors(joined ? null : artwork);
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
  const myUserId = useMyUserId();
  const hostControl = canControl({
    roomAuth: f.roomAuth,
    myUserId,
    hostUserId: store.state?.hostUserId,
    ownerUserId: store.state?.ownerUserId,
    admins: store.state?.admins,
  });
  // Moderation and role management are host or owner only (not admins).
  const moderate = canControl({
    roomAuth: f.roomAuth,
    myUserId,
    hostUserId: store.state?.hostUserId,
    ownerUserId: store.state?.ownerUserId,
  });

  // Listener presence is rendered by ListenersStage, which reads the store
  // directly (per-connection members, name suffix on duplicates).
  const transportState = store.state?.transport?.state;
  const isPlaying = transportState === 'playing';

  const doJoin = useCallback(
    async (name: string) => {
      setLoading(true);
      setJoinError('');
      try {
        await joinRoom(roomId, name, platformRef.current);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync of external sessionStorage state into a connection side effect (join) on mount, not a render-driven state update
    if (saved) doJoin(saved);
  }, [joined, doJoin]);

  // "Ouvir no" switched (or the track changed service) between players that are
  // already alive: point drift correction and auto-advance at the new one. The
  // YouTube player announces itself on mount, and its unmount (cleanup runs
  // before this effect) clears the old one. The new player then seeks to the
  // synced position through the drift correction below.
  useEffect(() => {
    // A source whose player has not announced itself yet leaves no active
    // player (null), never the previous service's one; it is set when it does.
    if (activeSource === 'spotify') setActivePlayer(spotifyAdapterRef.current);
    else if (activeSource === 'apple') setActivePlayer(appleAdapterRef.current);
    else if (activeSource === 'youtube') {
      // YouTube announces itself on mount; just drop a Spotify/Apple one.
      setActivePlayer((p) => (p && (p === spotifyAdapterRef.current || p === appleAdapterRef.current) ? null : p));
    }
  }, [activeSource]);

  // Local volume: applied to whichever player is active, and again whenever it
  // changes (mount, "Ouvir no" switch), so a new player never starts at its own
  // default level. Never sent to the server.
  useApplyVolume(activePlayer);

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
    // Pre-join screen on the same ground component as the room (#325). Before
    // joining the client holds no room state (the room channel is only
    // subscribed by joinRoom), so this is the idle ground: no cover, no member
    // list.
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
              active={activeSource === 'spotify'}
              onPlayerReady={(player) => {
                spotifyAdapterRef.current = player;
                if (activeSourceRef.current === 'spotify') setActivePlayer(player);
              }}
              onPlayerGone={() => {
                spotifyAdapterRef.current = null;
                if (activeSourceRef.current === 'spotify') setActivePlayer(null);
              }}
              onPlayError={setPlayFailedId}
            />
          )}
          {f.apple && (
            <ApplePlayer
              authorized={appleAuthorized}
              onAuthorized={setAppleAuthorized}
              active={activeSource === 'apple'}
              onPlayerReady={(player) => {
                appleAdapterRef.current = player;
                if (activeSourceRef.current === 'apple') setActivePlayer(player);
              }}
              onPlayerGone={() => {
                appleAdapterRef.current = null;
                if (activeSourceRef.current === 'apple') setActivePlayer(null);
              }}
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

  const fallbackWanted = preference !== 'auto' && resolved.fellBack ? preference : null;
  const servicePicker = (
    <ListeningServicePicker
      preference={preference}
      onChange={setListeningService}
      spotifyEnabled={f.spotify}
      appleEnabled={f.apple}
      spotifyConnected={spotifyAuthorized}
      appleConnected={appleAuthorized}
      onConnectSpotify={() => {
        beginAuth(window.location.pathname).catch((e) => console.error('Spotify connect failed:', e));
      }}
      fallback={nowPlaying && fallbackWanted && resolved.reason ? { wanted: fallbackWanted, playing: activeSource, reason: resolved.reason } : null}
    />
  );

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
      hostLabel={Boolean(f.roomAuth && store.state?.hostUserId && store.state.hostUserId === myUserId)}
      onNext={nowPlaying ? () => nowPlayingAdvance(roomId, nowPlaying.id).catch(() => {}) : undefined}
      activeSource={activeSource}
      servicePicker={servicePicker}
      volumeControl={<VolumeControl />}
      activePlayer={activePlayer}
      roomAgeS={roomAgeS}
      radioOn={radioOn}
      onOpenDepth={() => setTrackDepthOpen(true)}
      onOpenLyrics={() => setLyricsOpen(true)}
      onOpenEnrichment={() => setEnrichmentOpen(true)}
    />
  );

  const listenersStage = (
    <ListenersStage
      roomId={roomId}
      canModerate={moderate}
      running={isPlaying}
      hostUserId={store.state?.hostUserId}
      admins={store.state?.admins}
      ownerUserId={store.state?.ownerUserId}
    />
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
      <QueuePanel roomId={roomId} canControl={hostControl} onAdd={goToAdd} listeningOn={platform} />
      <ActivityRail />
    </>
  );
  const chatPanel = f.roomChat ? <ChatPanel roomId={roomId} canControl={moderate} /> : null;

  const roomName = cleanLabel(store.state?.name);
  const listeners = store.members.length;
  // Same seed as the ListenersStage avatar: userId when present, else clientId.
  const meSeed = store.members.find((m) => (m.clientIds ?? [m.clientId]).includes(store.clientId))?.userId ?? (store.clientId || store.name);
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
              <Link href="/account" className="r4-me" aria-label={`Conta de ${store.name}`} title="Conta" style={{ background: avatarGradient(meSeed) }}>
                {store.name.charAt(0).toUpperCase()}
              </Link>
            ) : (
              <span className="r4-me" title={store.name} style={{ background: avatarGradient(meSeed) }} aria-hidden="true">
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
