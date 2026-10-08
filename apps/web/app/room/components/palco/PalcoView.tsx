'use client';

// Modo palco (docs/design/modo-palco.md): the room as a pixel art festival
// stage. The real YouTube player is not rendered here: it stays mounted where
// the round 4 room put it and CSS lifts it over the stage screen through the
// --palco-s* variables this view writes (globals.css, `.room[data-view=palco]`),
// so switching views never reloads it. Tags, bubbles and the HUD are laid out
// around the screen rectangle and never over it.
//
// Loaded with next/dynamic (ssr: false) from the room client, so three.js and
// this file stay out of the round 4 bundle.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore, onWoot, sendWoot } from '@/lib/realtime';
import { memberLabel } from '@/lib/nameSuffix';
import { memberCharacter } from '@/lib/characters';
import { useMotion } from '@/lib/motionFlags';
import { usePalcoMotion, setPalcoMotion } from '@/lib/palcoView';
import { computeExpectedPosition, serverNow } from '@/lib/playbackSync';
import {
  WORLDS, pickWorld, frameStage, screenRect, boothMembers, crowdMembers, crowdSlots, memberKey,
  newVoters, memberForVoter, memberForClient, placeBubble, placeTag, type Framing, type WorldKind,
} from '@/lib/palco';
import { PalcoScene, loadSceneImages, type FrameOut } from './scene';
import type { Member } from '@/lib/realtime';
import type { RoomState } from '@cojam/shared';

type Panel = 'stage' | 'queue' | 'chat';

interface PalcoViewProps {
  roomId: string;
  queue: ReactNode;
  chat: ReactNode | null;
  queueCount: number;
  // A YouTube player (the room's own) is on the screen; otherwise the cover art shows.
  hasPlayer: boolean;
  artwork: string | null;
}

const BUBBLE_MS = 4500;
const LIKE_COOLDOWN_MS = 1500;
const VARS = ['--palco-sx', '--palco-sy', '--palco-sw', '--palco-sh'] as const;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function isMe(m: Member, clientId: string): boolean {
  return Boolean(clientId) && (m.clientIds ?? [m.clientId]).includes(clientId);
}

interface Bubble {
  id: string;
  key: string;
  text: string;
}

export function PalcoView({ roomId, queue, chat, queueCount, hasPlayer, artwork }: PalcoViewProps) {
  const state = useStore((s) => s.state);
  const members = useStore((s) => s.members);
  const clientId = useStore((s) => s.clientId);
  const suffixes = useStore((s) => s.nameSuffixes);
  const messages = useStore((s) => s.chat);

  const [kind, setKind] = useState<WorldKind>(() => (typeof window === 'undefined' ? 'wide' : pickWorld(window.innerWidth, window.innerHeight)));
  const world = WORLDS[kind];
  const [panel, setPanel] = useState<Panel>('stage');
  const activePanel: Panel = panel === 'chat' && !chat ? 'stage' : panel;
  const compact = kind === 'phone' && activePanel !== 'stage';
  const [size, setSize] = useState<{ cw: number; ch: number } | null>(null);
  const framing: Framing | null = useMemo(() => (size && size.cw > 0 ? frameStage(world, size.cw, size.ch, compact) : null), [world, size, compact]);
  const screen = framing ? screenRect(world, framing) : null;

  const motionPref = usePalcoMotion();
  const sys = useMotion();
  const motion = motionPref && !sys.reduced;

  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<PalcoScene | null>(null);
  const [glFailed, setGlFailed] = useState(false);

  // --- who is where ---
  const booths = useMemo(() => boothMembers(state, members), [state, members]);
  const crowd = useMemo(() => crowdMembers(members, booths), [members, booths]);
  const youIndex = crowd.findIndex((m) => isMe(m, clientId));
  const placed = useMemo(() => (framing ? crowdSlots(crowd.length, world, framing, youIndex) : { slots: [], overflow: 0 }), [crowd.length, world, framing, youIndex]);
  const entries = useMemo(
    () => crowd.flatMap((m, i) => (placed.slots[i] ? [{ m, key: memberKey(m), characterId: memberCharacter(m), slot: placed.slots[i] }] : [])),
    [crowd, placed],
  );
  const boothLabel = (m: Member | null, verb: string) => (m ? `${isMe(m, clientId) ? 'Você' : memberLabel(m, suffixes)} · ${verb}` : '');

  // --- measuring: the stage column width, and the height left by the HUD ---
  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const hud = hudRef.current;
    if (!root || !stage || !hud) return;
    const measure = () => {
      setSize((prev) => {
        const cw = Math.floor(stage.clientWidth);
        const ch = Math.max(0, Math.floor(root.clientHeight - hud.offsetHeight));
        return prev && prev.cw === cw && prev.ch === ch ? prev : { cw, ch };
      });
      const next = pickWorld(window.innerWidth, window.innerHeight);
      setKind((k) => (k === next ? k : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(stage);
    ro.observe(hud);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [kind]);

  // --- the player rectangle: CSS variables the room's YouTube player reads ---
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !screen) return;
    const root = document.documentElement;
    const write = () => {
      const r = stage.getBoundingClientRect();
      root.style.setProperty('--palco-sx', `${Math.round(r.left + screen.x)}px`);
      root.style.setProperty('--palco-sy', `${Math.round(r.top + screen.y)}px`);
      root.style.setProperty('--palco-sw', `${screen.w}px`);
      root.style.setProperty('--palco-sh', `${screen.h}px`);
    };
    write();
    window.addEventListener('scroll', write, { passive: true });
    window.addEventListener('resize', write);
    const ro = new ResizeObserver(write);
    ro.observe(stage);
    return () => {
      window.removeEventListener('scroll', write);
      window.removeEventListener('resize', write);
      ro.disconnect();
    };
  }, [screen?.x, screen?.y, screen?.w, screen?.h]); // eslint-disable-line react-hooks/exhaustive-deps -- the rectangle, not the object identity
  useEffect(() => () => VARS.forEach((v) => document.documentElement.style.removeProperty(v)), []);

  // --- the scene: one per world (wide or vertical plate) ---
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    // A fresh canvas per scene: a WebGL context is never reused after dispose.
    const canvas = document.createElement('canvas');
    canvas.className = 'palco__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    let cancelled = false;
    let made: PalcoScene | null = null;
    loadSceneImages(WORLDS[kind])
      .then((imgs) => {
        if (cancelled) return;
        made = new PalcoScene(canvas, WORLDS[kind], imgs);
        made.start();
        setGlFailed(false);
        setScene(made);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[palco] scene unavailable, showing the still stage:', err);
        setGlFailed(true);
      });
    return () => {
      cancelled = true;
      made?.dispose();
      canvas.remove();
      setScene(null);
    };
  }, [kind]);

  useEffect(() => {
    if (scene && framing) scene.resize(framing);
  }, [scene, framing]);
  useEffect(() => {
    scene?.setMotion(motion);
  }, [scene, motion]);
  useEffect(() => {
    scene?.setCrowd(entries.map(({ key, characterId, slot }) => ({ key, characterId, slot })));
  }, [scene, entries]);
  useEffect(() => {
    if (!scene) return;
    const entry = (m: Member | null) => (m ? { key: memberKey(m), characterId: memberCharacter(m) } : null);
    scene.setBooths(entry(booths.left), entry(booths.right));
  }, [scene, booths]);

  // --- reactions: Curtir (reaction.woot), upvotes (votes diff), chat bubbles ---
  const nowPlayingId = state?.nowPlayingId;
  const [likes, setLikes] = useState<{ track: string | undefined; n: number }>({ track: undefined, n: 0 });
  const likeCount = likes.track === nowPlayingId ? likes.n : 0;
  const bump = useCallback(() => setLikes((l) => ({ track: nowPlayingId, n: (l.track === nowPlayingId ? l.n : 0) + 1 })), [nowPlayingId]);
  const membersRef = useRef(members);
  const sceneRef = useRef(scene);
  const bumpRef = useRef(bump);
  useEffect(() => {
    membersRef.current = members;
    sceneRef.current = scene;
    bumpRef.current = bump;
  });

  useEffect(() => onWoot((cid) => {
    if (cid === useStore.getState().clientId) return; // our own press already wooted locally
    const m = memberForClient(cid, membersRef.current);
    if (!m) return;
    sceneRef.current?.woot(memberKey(m));
    bumpRef.current();
  }), []);

  const prevVotes = useRef<RoomState['votes'] | undefined>(undefined);
  useEffect(() => {
    const votes = state?.votes;
    const before = prevVotes.current;
    prevVotes.current = votes;
    if (before === undefined) return; // the first state seen is the baseline
    for (const key of newVoters(before, votes)) {
      const m = memberForVoter(key, membersRef.current);
      if (m) sceneRef.current?.woot(memberKey(m));
    }
  }, [state?.votes]);

  const [cooling, setCooling] = useState(false);
  const like = () => {
    if (cooling) return;
    const me = members.find((m) => isMe(m, clientId));
    if (me) scene?.woot(memberKey(me));
    bump();
    setCooling(true);
    window.setTimeout(() => setCooling(false), LIKE_COOLDOWN_MS);
    sendWoot(roomId).catch(() => { /* the local woot already showed; the room just misses this one */ });
  };

  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const seenChat = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!seenChat.current) {
      // Lines from before the stage opened never pop up.
      seenChat.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh = messages.filter((m) => !seenChat.current!.has(m.id));
    fresh.forEach((m) => seenChat.current!.add(m.id));
    const lines = fresh.flatMap((msg) => {
      if (msg.kind === 'system' || msg.deleted || !msg.text) return [];
      const m = (msg.userId && membersRef.current.find((x) => x.userId === msg.userId)) || membersRef.current.find((x) => x.name === msg.name);
      return m ? [{ id: msg.id, key: memberKey(m), text: msg.text }] : [];
    });
    if (!lines.length) return;
    setBubbles((b) => [...b.filter((x) => !lines.some((l) => l.key === x.key)), ...lines]);
    const timers = lines.map((l) => window.setTimeout(() => setBubbles((b) => b.filter((x) => x.id !== l.id)), BUBBLE_MS));
    return () => timers.forEach(clearTimeout);
  }, [messages]);

  // --- overlays follow the sprites every frame (imperative: no React render per frame) ---
  const tagRefs = useRef(new Map<string, HTMLElement>());
  const bubbleRefs = useRef(new Map<string, HTMLElement>());
  const layoutRef = useRef<{ screen: typeof screen; viewW: number; below: boolean }>({ screen: null, viewW: 0, below: false });
  useEffect(() => {
    layoutRef.current = { screen, viewW: size?.cw ?? 0, below: kind === 'phone' };
  });
  useEffect(() => {
    if (!scene) return;
    const sizeOf = (el: HTMLElement) => {
      if (el.dataset.measured !== el.textContent) {
        el.dataset.w = String(el.offsetWidth);
        el.dataset.h = String(el.offsetHeight);
        el.dataset.measured = el.textContent ?? '';
      }
      return [Number(el.dataset.w), Number(el.dataset.h)] as const;
    };
    const show = (el: HTMLElement, left: number, top: number) => {
      const v = `translate(${left}px, ${top}px)`;
      if (el.style.transform !== v) el.style.transform = v;
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    };
    const hide = (el: HTMLElement) => {
      if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
    };
    scene.setFrameListener((out: FrameOut) => {
      const { screen: s, viewW, below } = layoutRef.current;
      if (!s) return;
      for (const [key, el] of tagRefs.current) {
        const a = key === 'booth-L' ? out.booths[0] : key === 'booth-R' ? out.booths[1] : out.people.get(key);
        if (!a || !a.visible) { hide(el); continue; }
        const [tw, th] = sizeOf(el);
        const isBooth = key.startsWith('booth-');
        const p = placeTag(a.x, a.y, tw, th, viewW, s, isBooth && below);
        show(el, p.left, p.top);
      }
      for (const [key, el] of bubbleRefs.current) {
        const a = out.people.get(key) ?? (out.booths[0].key === key ? out.booths[0] : out.booths[1].key === key ? out.booths[1] : undefined);
        if (!a || !a.visible) { hide(el); continue; }
        const [bw, bh] = sizeOf(el);
        // Above the name tag: the tag is ~20 px over the head.
        const p = placeBubble(a.x, a.y - 22, bw, bh, viewW, s);
        el.style.setProperty('--tail', `${p.tail}px`);
        show(el, p.left, p.top);
      }
    });
    return () => scene.setFrameListener(null);
  }, [scene]);

  const tagRef = (key: string) => (el: HTMLElement | null) => {
    if (el) tagRefs.current.set(key, el);
    else tagRefs.current.delete(key);
  };
  const bubbleRef = (key: string) => (el: HTMLElement | null) => {
    if (el) bubbleRefs.current.set(key, el);
    else bubbleRefs.current.delete(key);
  };

  // --- now playing and progress ---
  const nowPlaying = nowPlayingId ? state?.queue.find((t) => t.id === nowPlayingId) : undefined;
  const transport = state?.transport;
  const [pos, setPos] = useState(0);
  useEffect(() => {
    const tick = () => setPos(computeExpectedPosition(transport, serverNow()));
    tick();
    if (transport?.state !== 'playing') return;
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [transport]);
  const duration = nowPlaying?.durationMs ?? 0;
  const pct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;
  const leftMember = booths.left;
  const byLabel = nowPlaying
    ? leftMember && isMe(leftMember, clientId) ? 'Você pediu' : `${(leftMember && memberLabel(leftMember, suffixes)) || nowPlaying.addedBy} pediu`
    : '';

  const tabs: Array<[Panel, string]> = [['stage', 'Palco'], ['queue', `Fila (${queueCount})`], ...(chat ? ([['chat', 'Chat']] as Array<[Panel, string]>) : [])];
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex(([id]) => id === activePanel);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    setPanel(next);
    document.getElementById(`palco-tab-${next}`)?.focus();
  };

  const stageImgStyle = framing
    ? { left: framing.ox - framing.camLeft * framing.scale, top: -framing.camTop * framing.scale, width: world.W * framing.scale, height: world.H * framing.scale }
    : undefined;

  return (
    <section ref={rootRef} className="palco" data-world={kind} data-panel={activePanel} data-motion={motion ? 'on' : 'off'} aria-label="Modo palco" data-testid="palco">
      <div className="palco__main">
        <div ref={stageRef} className="palco__stage" style={framing ? { height: framing.height } : undefined}>
          <div ref={canvasHostRef} className="palco__gl" hidden={glFailed} />
          {glFailed && stageImgStyle && (
            // eslint-disable-next-line @next/next/no-img-element -- pixel art at an integer scale, never resampled
            <img className="palco__still" src={world.src} alt="" style={stageImgStyle} />
          )}
          {screen && (
            <div className="palco__screen" style={{ left: screen.x, top: screen.y, width: screen.w, height: screen.h }} data-has-player={hasPlayer ? 'true' : 'false'}>
              {!hasPlayer && (artwork ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote cover art from the queue, like the round 4 card
                <img src={artwork} alt={nowPlaying ? `Capa de ${nowPlaying.title}` : ''} />
              ) : (
                <span className="palco__screen-empty">{nowPlaying ? nowPlaying.title : 'Nada tocando'}</span>
              ))}
            </div>
          )}
          <div className="palco__tags" aria-hidden="true">
            {(['L', 'R'] as const).map((side) => {
              const m = side === 'L' ? booths.left : booths.right;
              if (!m) return null;
              return (
                <span key={`booth-${side}-${memberKey(m)}`} ref={tagRef(`booth-${side}`)} className={`palco-tag palco-tag--dj${isMe(m, clientId) ? ' palco-tag--you' : ''}`}>
                  {boothLabel(m, side === 'L' ? 'tocando' : 'próxima')}
                </span>
              );
            })}
            {entries.map(({ m, key, slot }) => (
              <span key={key} ref={tagRef(key)} className={`palco-tag${isMe(m, clientId) ? ' palco-tag--you' : ''}${slot.row === 1 ? ' palco-tag--back' : ''}`} style={{ maxWidth: framing ? world.spacing * framing.scale - 4 : undefined }}>
                {isMe(m, clientId) ? 'Você' : memberLabel(m, suffixes)}
              </span>
            ))}
          </div>
          <div className="palco__bubbles" aria-hidden="true">
            {bubbles.map((b) => (
              <p key={b.id} ref={bubbleRef(b.key)} className="palco-bubble">{b.text}</p>
            ))}
          </div>
          {placed.overflow > 0 && <span className="palco__more">+{placed.overflow} na plateia</span>}
        </div>

        <div ref={hudRef} className="palco__hud" data-testid="palco-hud">
          <div className="palco__now">
            <p className="palco__title">
              {nowPlaying ? (
                <>
                  <span className="palco__song">{nowPlaying.title}</span>
                  <span className="palco__artist"> · {nowPlaying.artist}</span>
                </>
              ) : (
                <span className="palco__song">Nada tocando agora</span>
              )}
            </p>
            {nowPlaying && <span className="palco__chip">{byLabel}</span>}
            {nowPlaying && duration > 0 && (
              <div className="palco__bar">
                <span>{clock(pos)}</span>
                <span className="palco__track" role="progressbar" aria-label="Progresso da música" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                  <span className="palco__fill" style={{ width: `${pct}%` }} />
                </span>
                <span>{clock(duration)}</span>
              </div>
            )}
          </div>
          <div className="palco__acts">
            <button type="button" className="palco__like" onClick={like} disabled={!nowPlaying} aria-disabled={cooling || undefined}>
              <svg viewBox="0 0 7 6" width="14" height="12" aria-hidden="true" shapeRendering="crispEdges">
                <path fill="currentColor" d="M1 0h2v1h1V0h2v1h1v2H6v1H5v1H4v1H3V5H2V4H1V3H0V1h1z" />
              </svg>
              Curtir
              {likeCount > 0 && <span className="palco__likes" aria-label={`${likeCount} curtidas`}>{likeCount}</span>}
            </button>
            <button
              type="button"
              className="palco__toggle"
              aria-pressed={motion}
              disabled={sys.reduced}
              title={sys.reduced ? 'O sistema pediu menos movimento' : undefined}
              onClick={() => setPalcoMotion(!motionPref)}
            >
              Movimento
            </button>
          </div>
          <div className="palco__tabs" role="tablist" aria-label="Painéis do palco" onKeyDown={onTabKey}>
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`palco-tab-${id}`}
                aria-selected={activePanel === id}
                aria-controls={id === 'stage' ? undefined : 'palco-panel'}
                tabIndex={activePanel === id ? 0 : -1}
                className="palco__tab"
                onClick={() => setPanel(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activePanel !== 'stage' && (
        <div id="palco-panel" className="palco__panel" role="tabpanel" aria-labelledby={`palco-tab-${activePanel}`}>
          {activePanel === 'queue' ? queue : chat}
        </div>
      )}
    </section>
  );
}

export default PalcoView;
