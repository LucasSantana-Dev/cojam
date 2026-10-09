'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useStore, useMyUserId, joinRoom, nowPlayingAdvance, updatePlatform, updateCharacter, isPermissionDeniedError } from '@/lib/realtime';
import { useDriftCorrection } from '@/lib/useDriftCorrection';
import { advanceWithRetry } from '@/lib/backgroundPlayback';
import { StatusBanner } from '../components/StatusBanner';
import { readGuestName, saveGuestName } from '@/lib/guestName';

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
import { useSkipUnplayable } from '@/lib/useSkipUnplayable';
import { getAccountSession, getConnectedServices, getDisplayName, markServiceConnected } from '@/lib/account';
import { supabaseEnabled } from '@/lib/supabase';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { SpotifyPlayer } from '../components/SpotifyPlayer';
import { QueuePanel } from '../components/QueuePanel';
import { ChatPanel } from '../components/ChatPanel';
import { AddTrackForm } from '../components/AddTrackForm';
import { ListenersStage } from '../components/ListenersStage';
import { ShareRoomButton } from '../components/ShareRoomButton';
import { ReportRoomButton } from '../components/ReportRoomButton';
import { PublicRoomToggle } from '../components/PublicRoomToggle';
import { AvatarMenu } from '../components/AvatarMenu';
import { CharacterPicker } from '../components/CharacterPicker';
import { useStoredCharacter, setStoredCharacter, defaultCharacterId, memberCharacter, CHARACTER_NAMES } from '@/lib/characters';
import { getStoredUserId } from '@/lib/auth';
import { OnboardingCard } from '../components/OnboardingCard';
import { TrackDepthPanel } from '../components/TrackDepthPanel';
import { LyricsPanel } from '../components/LyricsPanel';
import { EnrichmentPanel } from '../components/EnrichmentPanel';
import { NowPlayingCard } from '../components/NowPlayingCard';
import { VolumeControl } from '../components/VolumeControl';
import { useVisualSync } from '@/lib/useVisualSync';
import { useApplyVolume } from '@/lib/volume';
import { ListeningServicePicker } from '../components/ListeningServicePicker';
import { Stage } from '../components/Stage';
import { LogoMark } from '@/app/components/Logo';
import type { IPlayer } from '@/lib/playerInterface';
import { queueArtwork } from '../components/QueuePanel';
import { useMotion } from '@/lib/motionFlags';
import { useCoverFlight } from '@/lib/useCoverFlight';
import { ServiceBadge } from '@/app/components/ServiceBadge';
import { PalcoNav } from '@/app/components/PalcoNav';
import { PalcoScene } from '@/app/components/PalcoScene';
import { PalcoBrandBar } from '@/app/components/PalcoShell';
import { serviceOptions, ServiceFallbackNote } from '../components/ListeningServicePicker';
import { SpotifyProblemNote } from '../components/SpotifyProblemNote';
import { YouTubeQuotaNote } from '../components/YouTubeQuotaNote';
import type { SpotifyConnectErrorKind } from '@/lib/spotifyConnectError';
import { fixtureKind, applyRoomFixture, fixturePlayer } from '@/lib/devFixture';
import dynamic from 'next/dynamic';
import { usePalcoView, setPalcoView } from '@/lib/palcoView';

// Modo palco: client-only chunk (three.js), never in the round 4 bundle.
// While the chunk (three.js) loads, a plain stage-coloured block holds the
// space, so the room never flashes an empty area.
const PalcoView = dynamic(() => import('../components/palco/PalcoView'), {
  ssr: false,
  loading: () => <section className="palco palco--loading" aria-hidden="true" data-testid="palco-loading" />,
});

type VideoPanelTab = 'playing' | 'queue' | 'chat';
// One side drawer at a time: opening one closes the other.
type Drawer = 'depth' | 'lyrics' | 'enrichment' | null;

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
  // Dev fixture only (lib/devFixture): no SDK or iframe is mounted, the room is seeded.
  const [fixture, setFixture] = useState(false);
  // ?yt=1 with the fixture: a stand-in for the YouTube player in the cover slot.
  const [fixtureYt, setFixtureYt] = useState(false);
  const [spotifyAuthorized, setSpotifyAuthorized] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  // "+ Adicionar música" opens the search inline at the top of the queue.
  const [addOpen, setAddOpen] = useState(false);
  const [activePlayer, setActivePlayer] = useState<IPlayer | null>(null);
  // The Spotify adapter outlives a switch to another service: keep it so
  // switching back hands drift correction the right player again.
  const spotifyAdapterRef = useRef<IPlayer | null>(null);
  // Per-user playback failure: id of the now-playing track this client's
  // provider failed to play, reported by the player adapters. Local-only;
  // never touches transport state or other members.
  const [playFailedId, setPlayFailedId] = useState<string | null>(null);
  // Why Spotify is silent (set by SpotifyPlayer, which lives in the closed avatar menu).
  const [spotifyProblem, setSpotifyProblem] = useState<{ kind: SpotifyConnectErrorKind; retry?: () => void } | null>(null);
  const onSpotifyProblem = useCallback((kind: SpotifyConnectErrorKind | null, retry?: () => void) => {
    setSpotifyProblem(kind ? { kind, retry } : null);
  }, []);
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
  const store = useStore();
  const nowPlaying = store.state?.nowPlayingId
    ? store.state.queue.find((t) => t.id === store.state!.nowPlayingId)
    : undefined;
  // "Ouvir no": the person's service choice. An explicit choice wins when it
  // can play this track; otherwise the auto order applies and fellBack says so.
  const preference = useListeningService();
  const pickOpts = { spotifyAuthorized, preference };
  const resolved = nowPlaying ? resolveSource(nowPlaying, pickOpts) : { source: null, fellBack: false, reason: null };
  const activeSource = resolved.source;
  // The presence badge: the service this person listens through, track-independent.
  const platform = listeningPlatform(pickOpts);
  // Keep the badge in step with the choice (and with Spotify finishing
  // its authorization after the join): reconnects with fresh ConnInfo only on
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
  // The audience character: the stored choice goes out once the join settles
  // and again on every change (never a reconnect). A person who never chose
  // sends nothing and shows the default derived from the userId.
  const storedCharacter = useStoredCharacter();
  useEffect(() => {
    if (joined && storedCharacter) updateCharacter(roomId, storedCharacter);
  }, [joined, roomId, storedCharacter]);
  // Pre-join only: the guest id this browser already holds seeds the default.
  const preJoinUserId = useSyncExternalStore(noopSubscribe, () => getStoredUserId() ?? '', () => '');
  // isUnavailable() is exactly "pickSource() found nothing for this client"
  const trackUnavailable = Boolean(nowPlaying) && activeSource === null;
  const queueEmpty = (store.state?.queue?.length ?? 0) === 0 && (store.state?.history?.length ?? 0) === 0;

  const artwork = nowPlaying ? queueArtwork(nowPlaying) : null;
  const [coverFail, setCoverFail] = useState<{ url: string | null; level: number }>({ url: null, level: 0 });
  const coverLevel = coverFail.url === artwork ? coverFail.level : 0;
  const motion = useMotion();
  useCoverFlight(nowPlaying?.id, motion.flip);
  // Modo palco (opt-in, remembered in this browser); the round 4 room is the default.
  const palco = usePalcoView();

  // U5: compute room control permission for this user
  const myUserId = useMyUserId();
  const hostControl = canControl({
    roomAuth: f.roomAuth,
    myUserId,
    hostUserId: store.state?.hostUserId,
    ownerUserId: store.state?.ownerUserId,
    admins: store.state?.admins,
  });
  // YouTube-only: a blocked embed (error 100/101/150) marks the card failed
  // for everyone, and a controller's client also skips the track after a delay.
  const reportSkipUnplayable = useSkipUnplayable(roomId, nowPlaying?.id, hostControl);
  const onYoutubePlayError = useCallback(
    (trackId: string | null) => {
      setPlayFailedId(trackId);
      reportSkipUnplayable(trackId);
    },
    [reportSkipUnplayable],
  );
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
        saveGuestName(name);
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

  // Dev-only deterministic room for visual review (lib/devFixture, never in a
  // production build): ?fixture=room joins a seeded room, ?fixture=join seeds
  // the state behind the pre-join screen.
  useEffect(() => {
    const kind = fixtureKind();
    if (!kind) return;
    applyRoomFixture(kind);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot dev fixture seed on mount
    setFixture(true);
    setFixtureYt(new URLSearchParams(window.location.search).get('yt') === '1');
    setSpotifyAuthorized(true);
    spotifyAdapterRef.current = fixturePlayer;
    if (kind === 'room' || kind === 'kicked') {
      setJoined(true);
      setActivePlayer(fixturePlayer);
    }
  }, []);

  // Auto-rejoin after a full-page nav (e.g. Spotify OAuth) using the saved name.
  useEffect(() => {
    if (joined) return;
    const saved = readGuestName();
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
    else if (activeSource === 'youtube') {
      // YouTube announces itself on mount; just drop a Spotify one.
      setActivePlayer((p) => (p && p === spotifyAdapterRef.current ? null : p));
    }
  }, [activeSource]);

  // Below 1024px the drawers are bottom sheets. While one is open, measure where
  // the player (the cover slot, or the video stage) ends and hand it to the CSS,
  // so the sheet starts below it and never covers the player.
  useEffect(() => {
    if (!drawer) return;
    const root = document.documentElement;
    const measure = () => {
      const el = document.getElementById('youtube-player');
      const holder = el?.closest<HTMLElement>('.stage, .r4-cover') ?? el;
      const bottom = holder ? Math.max(0, Math.ceil(holder.getBoundingClientRect().bottom)) : 0;
      root.style.setProperty('--r4-player-bottom', bottom > 0 ? `${bottom + 8}px` : '0px');
    };
    measure();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--r4-player-bottom');
    };
  }, [drawer]);

  // Local volume: applied to whichever player is active, and again whenever it
  // changes (mount, "Ouvir no" switch), so a new player never starts at its own
  // default level. Never sent to the server.
  useApplyVolume(activePlayer);

  // U4: Drift correction loop (gated by the sync feature flag). The hook keys
  // off the meaningful transport fields, not publication object identity (#177).
  useDriftCorrection(activePlayer, f.sync, hostControl);

  // Modo palco, decision 8: a Spotify listener sees the room's YouTube video on
  // the stage screen, muted and kept in step; Spotify still plays the audio.
  // Palco only, and only when the track has a YouTube match (else the cover).
  const [visualPlayer, setVisualPlayer] = useState<IPlayer | null>(null);
  // A video that cannot embed falls back to the cover, not a black frame.
  const [visualFailedId, setVisualFailedId] = useState<string | null>(null);
  const mutedVideo =
    palco && nowPlaying?.id !== visualFailedId && !fixture && f.youtube && activeSource === 'spotify' && nowPlaying?.kind !== 'video' && Boolean(nowPlaying?.sources.youtube?.videoId);
  useVisualSync(mutedVideo ? visualPlayer : null);

  // Auto-advance at track end for Spotify (YouTube also advances via its
  // native onStateChange; the server dedups through AdvanceAfter). onEnded has
  // no unsubscribe, so track the subscribed adapter instance and never
  // double-subscribe the same one.
  const advanceSubscribedRef = useRef<IPlayer | null>(null);
  useEffect(() => {
    if (!activePlayer || advanceSubscribedRef.current === activePlayer) return;
    advanceSubscribedRef.current = activePlayer;
    activePlayer.onEnded(() => {
      const id = useStore.getState().state?.nowPlayingId;
      if (id) {
        void advanceWithRetry(nowPlayingAdvance, () => useStore.getState().state?.nowPlayingId, roomId, id, isPermissionDeniedError);
      }
    });
  }, [activePlayer, roomId]);

  // Everything below needs the room's own tree; hooks all ran above.
  const roomName = cleanLabel(store.state?.name);
  const listeners = store.members.length;
  const radioOn = store.state?.radioEnabled ?? false;
  const radioAvailable = store.state?.radioAvailable !== false;
  const fallbackWanted = preference !== 'auto' && resolved.fellBack ? preference : null;
  const connectSpotify = () => {
    beginAuth(window.location.pathname).catch((e) => console.error('Spotify connect failed:', e));
  };

  if (!joined) {
    // Pre-join screen: a palco screen (wave 2, DESIGN.md "Palco on every screen"). The stage
    // screen reads "SALA" and the real room code, the picked character stands on the floor
    // with a lime "Você" tag and swaps live with the pick, the join form is one plate.
    const joinOptions = [
      f.spotify && { id: 'spotify' as const, label: 'Spotify' },
      f.youtube && { id: 'youtube' as const, label: 'YouTube' },
    ].filter((o): o is { id: 'spotify' | 'youtube'; label: string } => Boolean(o));
    const chosen = preference === 'auto' ? null : preference;
    const pickedCharacter = storedCharacter ?? defaultCharacterId(preJoinUserId);
    return (
      <div className="pw pwj" data-view="join">
        <PalcoBrandBar>
          <PalcoNav />
        </PalcoBrandBar>
        <PalcoScene
          kind="join"
          hero
          led={{ title: 'SALA', scale: 2, sub: roomId, subTone: 'white' }}
          you={{ id: pickedCharacter, name: CHARACTER_NAMES[pickedCharacter - 1] ?? '' }}
        >
          <main id="main" className="pwj-main">
            <form onSubmit={handleJoin} className="pw-plate pwj-panel">
              {/* One H1: the framing sentence plus the room (its name, else its code). */}
              <p className="pw-eyebrow">
                {roomName ? 'Você vai entrar na ' : 'Você vai entrar na sala '}
                <span className="pwj-code" data-testid="join-room-code">{roomName || roomId}</span>
              </p>
              <h1 className="pw-title pwj-title">Entrar na sala</h1>

              <CharacterPicker
                idPrefix="join-char"
                value={pickedCharacter}
                onChange={setStoredCharacter}
              />

              <label htmlFor="join-name" className="pw-label">Seu nome</label>
              <input
                id="join-name"
                type="text"
                placeholder="Seu nome"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                className="pw-input"
                autoComplete="nickname"
                autoFocus
              />

              {joinOptions.length > 1 && (
                <>
                  <p className="pw-label" id="join-where">Onde você ouve?</p>
                  <div className="pwj-svc" role="group" aria-labelledby="join-where">
                    {joinOptions.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className="pw-choice"
                        aria-pressed={chosen === o.id}
                        onClick={() => setListeningService(o.id)}
                      >
                        <ServiceBadge source={o.id} size="md" title="" />
                        {o.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <button type="submit" disabled={loading || !nameInput.trim()} className="pw-btn pwj-submit">
                {loading ? 'Entrando...' : 'Entrar na sala'}
              </button>

              {/* Guest-identity signal (#167): guests' identity lives in this
                  browser's localStorage only. Hidden from signed-in members and
                  when accounts are not deployed (no remedy to point at). */}
              {accountsEnabled && !store.signedIn && (
                <p className="pw-text pwj-note">
                  Sua identidade fica guardada neste navegador. Entre na sua conta antes de sair
                  da sala para manter seu papel em outros dispositivos.
                </p>
              )}

              {/* Error state */}
              {joinError && (
                <p className="pw-error" role="alert">
                  {joinError}
                </p>
              )}
            </form>
          </main>
        </PalcoScene>
      </div>
    );
  }

  // room.kick (#181): the server closed this connection with the terminal
  // kicked code. Replace the room UI entirely — no StatusBanner retry loop,
  // since the disconnect was deliberate and the connection will not retry.
  if (store.kicked) {
    return (
      <div className="pw" data-view="kicked">
        <PalcoBrandBar />
        {/* The join floor with nobody on it: the screen says the show is over for you. */}
        <PalcoScene kind="join" led={{ title: 'FIM', scale: 3, sub: 'Voce saiu da sala' }}>
          <main id="main" className="pw-dock pw-plate">
            <div className="pw-dock__copy">
              <p className="pw-eyebrow">Fim da sessão · para você</p>
              <h1 className="pw-title">Você foi removido da sala</h1>
              <p className="pw-text">O anfitrião removeu você desta sessão.</p>
            </div>
            <div className="pw-actions">
              <Link href="/" className="pw-btn">
                Voltar ao início
              </Link>
            </div>
          </main>
        </PalcoScene>
      </div>
    );
  }

  // Video rooms (#258): stage + panels, only when the flag is on, the
  // now-playing track is video and this client plays it through YouTube. Every
  // other case (audio track, flag off, Spotify source) keeps the
  // original two-column layout untouched.
  const videoMode =
    f.video && f.youtube && nowPlaying?.kind === 'video' && activeSource === 'youtube';

  const videoTabs: ReadonlyArray<readonly [VideoPanelTab, string]> = [
    ['playing', 'Agora'],
    ['queue', 'Fila'],
    ...(f.roomChat ? ([['chat', 'Chat']] as const) : []),
  ];

  // The Spotify player owns its SDK and its connect button. It lives in the
  // avatar menu ("Trocar serviço"), mounted whether it is open or not.
  const connectors = fixture ? null : (
    <>
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
          onProblem={onSpotifyProblem}
        />
      )}
    </>
  );

  // The YouTube player of an audio track takes the cover slot of the now-playing
  // card: visible, square, nothing overlaid (YouTube API terms).
  const youtubeAudio =
    !fixture && !videoMode && f.youtube && activeSource === 'youtube' ? (
      <YouTubePlayer
        roomId={roomId}
        fill
        onPlayerReady={setActivePlayer}
        onPlayerGone={() => setActivePlayer(null)}
        onPlayError={onYoutubePlayError}
      />
    ) : null;

  const pickerProps = {
    preference,
    onChange: setListeningService,
    spotifyEnabled: f.spotify,
    spotifyConnected: spotifyAuthorized,
    onConnectSpotify: connectSpotify,
    effective: platform,
  };
  // Only offer the icon row when there is a real choice to make.
  const servicePicker = serviceOptions(pickerProps).length > 1 ? <ListeningServicePicker {...pickerProps} /> : null;
  const serviceNote =
    spotifyProblem && activeSource === 'spotify' ? (
      <SpotifyProblemNote
        kind={spotifyProblem.kind}
        onRetry={spotifyProblem.retry}
        onUseYouTube={f.youtube ? () => setListeningService('youtube') : undefined}
      />
    ) : platform === 'youtube' && store.state?.youtubeQuotaUntil ? (
      // Spotify listeners are unaffected by the YouTube search quota.
      <YouTubeQuotaNote until={store.state.youtubeQuotaUntil} />
    ) : nowPlaying && fallbackWanted && resolved.reason ? (
      <ServiceFallbackNote fallback={{ wanted: fallbackWanted, playing: activeSource, reason: resolved.reason }} />
    ) : null;

  // Detalhes / Letra / Mais are one drawer slot: opening one closes the other.
  const closeDrawer = () => setDrawer(null);

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
      servicePicker={servicePicker}
      serviceNote={serviceNote}
      volumeControl={<VolumeControl />}
      activePlayer={activePlayer}
      radioOn={radioOn}
      radioAvailable={radioAvailable}
      onOpenDepth={() => setDrawer('depth')}
      onOpenLyrics={() => setDrawer('lyrics')}
      onOpenEnrichment={() => setDrawer('enrichment')}
      media={
        fixtureYt ? (
          <div id="youtube-player" className="r4-fixture-yt" />
        ) : (
          youtubeAudio ??
          (mutedVideo ? <YouTubePlayer roomId={roomId} fill muted onMutedError={setVisualFailedId} onPlayerReady={setVisualPlayer} onPlayerGone={() => setVisualPlayer(null)} /> : null)
        )
      }
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
    <AddTrackForm roomId={roomId} spotifyAuthorized={spotifyAuthorized} onAdded={palco ? () => setAddOpen(false) : undefined} />
  );

  const queuePanel = (
    <QueuePanel
      roomId={roomId}
      canControl={hostControl}
      onAdd={() => {
        setPanelTab('queue');
        setAddOpen((o) => !o);
      }}
      addOpen={addOpen}
      addSlot={addTrackForm}
      emptySlot={queueEmpty ? <OnboardingCard /> : undefined}
      listeningOn={platform}
    />
  );
  const chatPanel = f.roomChat ? <ChatPanel roomId={roomId} canControl={moderate} /> : null;
  // Modo palco shows the queue and chat in its own panels: never two copies.
  const r4Queue = palco ? null : queuePanel;
  const r4Chat = palco ? null : chatPanel;

  // Same seed as the ListenersStage avatar: userId when present, else clientId.
  const me = store.members.find((m) => (m.clientIds ?? [m.clientId]).includes(store.clientId));
  const myCharacter = storedCharacter ?? (me ? memberCharacter(me) : defaultCharacterId(store.clientId || store.name));
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
      className="room r4"
      data-room="r4"
      data-has-track={nowPlaying ? 'true' : 'false'}
      data-view={palco ? 'palco' : 'r4'}
      style={{ color: 'var(--color-text-primary)' }}
    >
      <StatusBanner />
      {/* Rebind soft notice (#172): proof verification failed (secret rotation
          or expiry), so guest contributions could not be linked. The room and
          the sign-in keep working; only the attribution handoff is lost. The
          live region stays mounted (empty when there is no notice) so screen
          readers announce the text when it appears. */}
      <p role="status" className="r4-notice">
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
          <div className="r4-actions">
            {(store.reconnecting || !store.connected) && (
              <span className="r4-conn" data-state={store.reconnecting ? 'reconnecting' : 'lost'}>
                <span className="connection-dot" data-state={store.reconnecting ? 'reconnecting' : 'lost'} />
                <span className="r4-conn__text">{store.reconnecting ? 'Reconectando...' : 'Desconectado'}</span>
              </span>
            )}
            <button
              type="button"
              className="r4-palco-toggle"
              aria-pressed={palco}
              aria-label="Modo palco"
              onClick={() => setPalcoView(!palco)}
            >
              <span className="r4-palco-toggle__long" aria-hidden="true">Modo palco</span>
              <span className="r4-palco-toggle__short" aria-hidden="true">Palco</span>
            </button>
            <ShareRoomButton />
            <AvatarMenu
              roomId={roomId}
              name={store.name}
              seed={meSeed}
              characterId={myCharacter}
              onCharacterChange={setStoredCharacter}
              platform={platform}
              serviceConnected={platform === 'spotify' && spotifyAuthorized}
              guest={accountsEnabled && !store.signedIn}
              accountsEnabled={accountsEnabled}
              picker={pickerProps}
              connectors={connectors}
              roomItems={
                <>
                  <ReportRoomButton roomId={roomId} />
                  {/* Directory opt-in is host-only (the server enforces it); non-hosts see nothing. */}
                  {hostControl && f.publicRooms && (
                    <div className="r4-menu__public">
                      <PublicRoomToggle roomId={roomId} />
                    </div>
                  )}
                </>
              }
            />
          </div>
        </div>
      </header>

      <main id="main" className="room-main r4-main">
        {palco && (
          <PalcoView
            roomId={roomId}
            queue={queuePanel}
            chat={chatPanel}
            queueCount={store.state?.queue.filter((t) => t.id !== store.state?.nowPlayingId).length ?? 0}
            hasPlayer={videoMode || Boolean(youtubeAudio) || mutedVideo || fixtureYt}
            artwork={artwork}
            canControl={hostControl}
            activePlayer={activePlayer}
            volume={<VolumeControl />}
            servicePicker={servicePicker}
            addOpen={addOpen}
            onAddOpen={() => setAddOpen(true)}
            onAddClose={() => setAddOpen(false)}
          />
        )}
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
                onPlayError={onYoutubePlayError}
              />
            </Stage>

            {tabs('')}

            <div data-testid="video-main-column" className="video-main r4-stack">
              <div id="video-panel-playing" role="tabpanel" aria-labelledby="video-tab-playing" className="video-panel r4-stack" data-active={panelTab === 'playing'}>
                {heroPanel}
                {listenersStage}
              </div>
            </div>

            <div data-testid="video-side-column" className="video-side r4-stack">
              <div id="video-panel-queue" role="tabpanel" aria-labelledby="video-tab-queue" className="video-panel r4-stack" data-active={panelTab === 'queue'}>
                {r4Queue}
              </div>
              {r4Chat && (
                <div id="video-panel-chat" role="tabpanel" aria-labelledby="video-tab-chat" className="video-panel" data-active={panelTab === 'chat'}>
                  {r4Chat}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="audio-room r4-grid" data-testid="audio-room" data-tab={panelTab}>
              <div data-testid="room-main-column" className="r4-main-col room-arrival" style={{ ['--i' as string]: 0 }}>
                {/* Below 768px the same Agora / Fila / Chat tabs as the video room
                    (#258) decide which panel shows; md and up shows every panel. */}
                <div id="video-panel-playing" role="tabpanel" aria-labelledby="video-tab-playing" className="video-panel video-panel-keep r4-stack r4-stage" data-active={panelTab === 'playing'}>
                  {heroPanel}
                  {listenersStage}
                </div>
              </div>

              <div data-testid="room-side-column" className="r4-side room-arrival" style={{ ['--i' as string]: 1 }}>
                <div id="video-panel-queue" role="tabpanel" aria-labelledby="video-tab-queue" className="video-panel r4-queue-col r4-stack" data-active={panelTab === 'queue'}>
                  {r4Queue}
                </div>
                {r4Chat && (
                  <div id="video-panel-chat" role="tabpanel" aria-labelledby="video-tab-chat" className="video-panel r4-chat-col" data-active={panelTab === 'chat'}>
                    {r4Chat}
                  </div>
                )}
              </div>
            </div>
            {tabs('audio-tabs')}
          </>
        )}
      </main>

      {/* Track Depth Panel */}
      <TrackDepthPanel
        roomId={roomId}
        track={nowPlaying || null}
        open={drawer === 'depth'}
        onClose={closeDrawer}
      />
      <LyricsPanel
        roomId={roomId}
        track={nowPlaying || null}
        open={drawer === 'lyrics'}
        onClose={closeDrawer}
        activePlayer={activePlayer}
      />
      <EnrichmentPanel
        roomId={roomId}
        track={nowPlaying || null}
        open={drawer === 'enrichment'}
        onClose={closeDrawer}
      />
    </div>
  );
}
