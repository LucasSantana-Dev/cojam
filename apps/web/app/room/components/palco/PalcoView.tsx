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
import { useStore, onWoot, sendWoot, onEmote, sendEmote, transportPlay, transportPause, nowPlayingAdvance } from '@/lib/realtime';
import { EMOTES, type Emote } from '@cojam/shared';
import { SkipNextIcon } from '@/app/components/icons';
import { playPauseLabel } from '../TransportUI';
import type { IPlayer } from '@/lib/playerInterface';
import { memberLabel } from '@/lib/nameSuffix';
import { memberCharacter } from '@/lib/characters';
import { useMotion } from '@/lib/motionFlags';
import { usePalcoMotion, setPalcoMotion } from '@/lib/palcoView';
import { computeExpectedPosition, serverNow } from '@/lib/playbackSync';
import {
  WORLDS, pickWorld, frameStage, playerRect, boothTop, boothMembers, crowdMembers, crowdSlots, memberKey,
  newVoters, memberForVoter, memberForClient, placeBubble, placeTag, upNext, boardRect, type Framing, type WorldKind,
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
  // HUD controls, so nobody leaves the stage to use them: the room's local
  // volume and "Ouvir no" picker (passed in as built by the room), and the
  // host transport (pause or play, skip), shown only to who can control.
  canControl?: boolean;
  activePlayer?: IPlayer | null;
  volume?: ReactNode;
  servicePicker?: ReactNode;
  // "+ Música": add a song without leaving the stage. The room owns the add
  // state (its QueuePanel hosts the form); palco opens the Fila panel under or
  // beside the stage, and goes back to the stage when `addOpen` turns off
  // (a song was added, or Esc).
  addOpen?: boolean;
  onAddOpen?: () => void;
  onAddClose?: () => void;
}

const BUBBLE_MS = 4500;
// Emotes: pop, float about EMOTE_FLOAT native px, blink out at EMOTE_MS.
const EMOTE_MS = 1500;
const EMOTE_FLOAT = 10;
const EMOTE_COOLDOWN_MS = 700; // the server allows one per 600 ms per connection; 100 ms margin for network jitter
const EMOTE_LABEL: Record<Emote, string> = {
  amei: 'Amei', fogo: 'Fogo', rindo: 'Rindo', palmas: 'Palmas', uau: 'Uau', cantando: 'Cantando',
};
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

// Host transport for the HUD: the same RPCs and gates as the round 4 TransportUI.
function PalcoTransport({ roomId, activePlayer, nowPlayingId, playing }: { roomId: string; activePlayer: IPlayer | null; nowPlayingId: string | undefined; playing: boolean }) {
  const label = playPauseLabel(playing ? 'playing' : 'paused');
  const playPause = async () => {
    try {
      if (playing) await transportPause(roomId, activePlayer ? await activePlayer.getCurrentPositionMs() : 0);
      else await transportPlay(roomId);
    } catch (err) {
      console.error('Transport control error:', err);
    }
  };
  const skip = () => {
    if (nowPlayingId) nowPlayingAdvance(roomId, nowPlayingId).catch((err) => console.error('Skip error:', err));
  };
  return (
    <>
      <button type="button" className="palco__ctrl" onClick={playPause} disabled={!activePlayer} aria-label={label} title={label}>
        {playing ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>
      <button type="button" className="palco__ctrl" onClick={skip} disabled={!nowPlayingId} aria-label="Próxima faixa" title="Próxima faixa">
        <SkipNextIcon size={22} />
      </button>
    </>
  );
}

export function PalcoView({ roomId, queue, chat, queueCount, hasPlayer, artwork, canControl = false, activePlayer = null, volume, servicePicker, addOpen = false, onAddOpen, onAddClose }: PalcoViewProps) {
  const state = useStore((s) => s.state);
  const members = useStore((s) => s.members);
  const clientId = useStore((s) => s.clientId);
  const suffixes = useStore((s) => s.nameSuffixes);
  const messages = useStore((s) => s.chat);

  const [kind, setKind] = useState<WorldKind>(() => (typeof window === 'undefined' ? 'wide' : pickWorld(window.innerWidth, window.innerHeight)));
  const world = WORLDS[kind];
  const [panel, setPanel] = useState<Panel>('stage');
  const activePanel: Panel = panel === 'chat' && !chat ? 'stage' : panel;
  // True while the add form was opened from the HUD: closing it returns to the stage.
  const [adding, setAdding] = useState(false);
  const sawOpen = useRef(false);
  useEffect(() => {
    if (!adding) {
      sawOpen.current = false;
    } else if (addOpen) {
      sawOpen.current = true;
    } else if (sawOpen.current) {
      setAdding(false);
      setPanel('stage');
    }
  }, [adding, addOpen]);
  const addRef = useRef<HTMLButtonElement>(null);
  const openAdd = () => {
    setAdding(true);
    setPanel('queue');
    onAddOpen?.();
  };
  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && adding) {
      e.stopPropagation();
      onAddClose?.();
      addRef.current?.focus();
    }
  };
  const compact = kind === 'phone' && activePanel !== 'stage';
  const [size, setSize] = useState<{ cw: number; ch: number } | null>(null);
  const framing: Framing | null = useMemo(() => (size && size.cw > 0 ? frameStage(world, size.cw, size.ch, compact) : null), [world, size, compact]);
  // The player rectangle (owner decision A: full width on the vertical stage).
  // Every overlay is laid out around it, never over it.
  const screen = framing && size ? playerRect(world, framing, size.cw) : null;

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

  // Re-writes the fixed player's position (set by the effect below): any
  // layout change, not only a new rectangle, can move the stage on the page.
  const writePlayerRef = useRef<() => void>(() => {});

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
      writePlayerRef.current();
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
    writePlayerRef.current = write;
    // A layout shift above the stage (banner, header wrap) or a phone keyboard
    // or dynamic toolbar (visualViewport) moves the stage without resizing it.
    const vv = window.visualViewport;
    window.addEventListener('scroll', write, { passive: true });
    window.addEventListener('resize', write);
    vv?.addEventListener('resize', write);
    vv?.addEventListener('scroll', write);
    const ro = new ResizeObserver(write);
    ro.observe(stage);
    if (rootRef.current) ro.observe(rootRef.current);
    ro.observe(document.documentElement);
    return () => {
      writePlayerRef.current = () => {};
      window.removeEventListener('scroll', write);
      window.removeEventListener('resize', write);
      vv?.removeEventListener('resize', write);
      vv?.removeEventListener('scroll', write);
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
    if (scene && framing && screen) scene.resize(framing, boothTop(world, framing, screen));
  }, [scene, framing, world, screen?.y, screen?.h]); // eslint-disable-line react-hooks/exhaustive-deps -- the rectangle, not the object identity
  useEffect(() => {
    scene?.setMotion(motion);
  }, [scene, motion]);
  // Battery: the shrunken phone stage under an open panel renders only on change.
  useEffect(() => {
    scene?.setIdle(compact);
  }, [scene, compact]);
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

  // --- emotes (reaction.emote): a pixel bubble over the sender's character ---
  const [emotes, setEmotes] = useState<Array<{ id: number; key: string; emote: Emote }>>([]);
  const emoteSeq = useRef(0);
  const emoteTimers = useRef(new Set<number>());
  const showEmote = useCallback((key: string, emote: Emote) => {
    const id = ++emoteSeq.current;
    setEmotes((list) => [...list.filter((x) => x.key !== key), { id, key, emote }]);
    const timer = window.setTimeout(() => {
      emoteTimers.current.delete(timer);
      setEmotes((list) => list.filter((x) => x.id !== id));
    }, EMOTE_MS);
    emoteTimers.current.add(timer);
  }, []);
  useEffect(() => {
    const timers = emoteTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  useEffect(() => onEmote((cid, emote) => {
    if (cid === useStore.getState().clientId) return; // our own press already showed locally
    const m = memberForClient(cid, membersRef.current);
    if (m) showEmote(memberKey(m), emote);
  }), [showEmote]);
  const [emoteCooling, setEmoteCooling] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const reactWrapRef = useRef<HTMLDivElement>(null);
  const reactToggleRef = useRef<HTMLButtonElement>(null);
  // The phone Reagir popup closes on Escape (focus back on its toggle) and on
  // a pointer press outside it.
  useEffect(() => {
    if (!reactOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      setReactOpen(false);
      reactToggleRef.current?.focus();
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.target instanceof Node && reactWrapRef.current?.contains(ev.target)) return;
      setReactOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [reactOpen]);
  const react = (emote: Emote) => {
    if (emoteCooling) return;
    const me = members.find((m) => isMe(m, clientId));
    if (me) showEmote(memberKey(me), emote);
    setEmoteCooling(true);
    window.setTimeout(() => setEmoteCooling(false), EMOTE_COOLDOWN_MS);
    setReactOpen(false);
    sendEmote(roomId, emote).catch(() => { /* shown locally; the room just misses this one */ });
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
  const emoteRefs = useRef(new Map<string, HTMLElement>());
  const layoutRef = useRef<{ screen: typeof screen; viewW: number; below: boolean; scale: number }>({ screen: null, viewW: 0, below: false, scale: 1 });
  useEffect(() => {
    layoutRef.current = { screen, viewW: size?.cw ?? 0, below: kind === 'phone', scale: framing?.scale ?? 1 };
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
      const { screen: s, viewW, below, scale } = layoutRef.current;
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
      for (const [key, el] of emoteRefs.current) {
        const a = out.people.get(key) ?? (out.booths[0].key === key ? out.booths[0] : out.booths[1].key === key ? out.booths[1] : undefined);
        if (!a || !a.visible) { hide(el); continue; }
        const [ew, eh] = sizeOf(el);
        // The float rises EMOTE_FLOAT native px: place the whole travel, so even
        // the top of the float stays off the player, then start at its foot.
        const float = EMOTE_FLOAT * scale;
        const p = placeBubble(a.x, a.y - 22, ew, eh + float, viewW, s);
        el.style.setProperty('--float', `${-float}px`);
        show(el, p.left, p.top + float);
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
  const emoteRef = (key: string) => (el: HTMLElement | null) => {
    if (el) emoteRefs.current.set(key, el);
    else emoteRefs.current.delete(key);
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

  // "A seguir": the next tracks on an LED board under the player, never over it.
  const upcoming = useMemo(() => upNext(state), [state]);
  const board = framing && screen ? boardRect(world, framing, screen, upcoming.length) : null;

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
          {board && (
            <section className="palco-board" aria-labelledby="palco-board-head" data-testid="palco-board" style={{ left: board.x, top: board.y, width: board.w, height: board.h }}>
              <p id="palco-board-head" className="palco-board__head">A seguir</p>
              <ol className="palco-board__list">
                {upcoming.slice(0, board.rows).map((t, i) => (
                  <li key={t.id} className="palco-board__row">
                    <span className="palco-board__n" aria-hidden="true">{i + 1}</span>
                    <span className="palco-board__t">{t.title}</span>
                    <span className="palco-board__a"> · {t.artist}</span>
                  </li>
                ))}
              </ol>
            </section>
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
            {emotes.map((e) => (
              <span key={e.id} ref={emoteRef(e.key)} className="palco-emote" data-emote={e.emote}>
                <span className="palco-emote__box">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 16 px pixel art at an integer scale */}
                  <img src={`/palco/emotes/${e.emote}.png`} alt="" width={32} height={32} />
                </span>
              </span>
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
            {kind === 'phone' ? (
              <div className="palco__react" ref={reactWrapRef}>
                <button
                  ref={reactToggleRef}
                  type="button"
                  className="palco__toggle palco__react-open"
                  aria-expanded={reactOpen}
                  aria-controls="palco-emotes"
                  disabled={!nowPlaying}
                  onClick={() => setReactOpen((o) => !o)}
                >
                  Reagir
                </button>
                {reactOpen && (
                  <div id="palco-emotes" className="palco__emotes palco__emotes--pop" role="group" aria-label="Reações">
                    {EMOTES.map((e) => (
                      <button key={e} type="button" className="palco__emote" aria-label={EMOTE_LABEL[e]} title={EMOTE_LABEL[e]} aria-disabled={emoteCooling || undefined} onClick={() => react(e)}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- 16 px pixel art at an integer scale */}
                        <img src={`/palco/emotes/${e}.png`} alt="" width={32} height={32} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="palco__emotes" role="group" aria-label="Reações">
                {EMOTES.map((e) => (
                  <button key={e} type="button" className="palco__emote" aria-label={EMOTE_LABEL[e]} title={EMOTE_LABEL[e]} disabled={!nowPlaying} aria-disabled={emoteCooling || undefined} onClick={() => react(e)}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- 16 px pixel art at an integer scale */}
                    <img src={`/palco/emotes/${e}.png`} alt="" width={32} height={32} />
                  </button>
                ))}
              </div>
            )}
            {onAddOpen && (
              <button ref={addRef} type="button" className="palco__toggle palco__add" aria-label="Adicionar música" title="Adicionar música" aria-expanded={adding && addOpen} aria-controls="palco-panel" onClick={openAdd}>
                <span aria-hidden="true">+</span><span className="palco__add-text" aria-hidden="true"> Música</span>
              </button>
            )}
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
          {(canControl || volume || servicePicker) && (
            <div className="palco__ctrls" role="group" aria-label="Controles da música">
              {canControl && <PalcoTransport roomId={roomId} activePlayer={activePlayer} nowPlayingId={nowPlayingId} playing={transport?.state === 'playing'} />}
              {volume}
              {servicePicker}
            </div>
          )}
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
                onClick={() => {
                  if (adding) {
                    setAdding(false);
                    onAddClose?.();
                  }
                  setPanel(id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activePanel !== 'stage' && (
        <div id="palco-panel" className="palco__panel" role="tabpanel" aria-labelledby={`palco-tab-${activePanel}`} onKeyDown={onPanelKey}>
          {activePanel === 'queue' ? queue : chat}
        </div>
      )}
    </section>
  );
}

export default PalcoView;
