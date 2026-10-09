import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ChatMessage, RoomState, TrackRef } from '@cojam/shared';
import { useStore, type Member } from '@/lib/realtime';
import { WORLDS, frameStage, screenRect } from '@/lib/palco';
import type { FrameOut } from './scene';

// The view wired to a fake scene: who stands where, which reactions woot whom,
// where chat bubbles land. The three.js scene itself is a browser concern
// (covered by e2e/palco.spec.ts).
const fake = vi.hoisted(() => {
  class FakeScene {
    static last: FakeScene | null = null;
    woots: string[] = [];
    crowd: Array<Array<{ key: string; characterId: number }>> = [];
    booths: Array<[{ key: string } | null, { key: string } | null]> = [];
    listener: ((out: FrameOut) => void) | null = null;
    constructor() {
      FakeScene.last = this;
    }
    start() {}
    dispose() {}
    resize() {}
    setMotion() {}
    setIdle() {}
    setCrowd(e: Array<{ key: string; characterId: number }>) { this.crowd.push(e); }
    setBooths(l: { key: string } | null, r: { key: string } | null) { this.booths.push([l, r]); }
    woot(k: string) { this.woots.push(k); }
    setFrameListener(cb: ((out: FrameOut) => void) | null) { this.listener = cb; }
  }
  return {
    FakeScene,
    wootListeners: [] as Array<(id: string) => void>,
    sendWoot: vi.fn(async () => {}),
    sendEmote: vi.fn(async () => {}),
    emoteListeners: [] as Array<(id: string, e: string) => void>,
    advance: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
  };
});
vi.mock('./scene', () => ({ PalcoScene: fake.FakeScene, loadSceneImages: async () => ({}) }));
vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  sendWoot: fake.sendWoot,
  nowPlayingAdvance: fake.advance,
  sendEmote: fake.sendEmote,
  onEmote: (cb: (id: string, e: string) => void) => {
    fake.emoteListeners.push(cb);
    return () => { fake.emoteListeners.splice(fake.emoteListeners.indexOf(cb), 1); };
  },
  transportPause: fake.pause,
  transportPlay: fake.play,
  onWoot: (cb: (id: string) => void) => {
    fake.wootListeners.push(cb);
    return () => { fake.wootListeners.splice(fake.wootListeners.indexOf(cb), 1); };
  },
}));

import { PalcoView } from './PalcoView';

const track = (id: string, addedBy: string, addedByUserId: string): TrackRef => ({ id, title: `Faixa ${id}`, artist: 'Artista', addedBy, addedByUserId, durationMs: 200000, sources: {} });
const MEMBERS: Member[] = [
  { clientId: 'c-bia', clientIds: ['c-bia'], userId: 'u-bia', name: 'Bia' },
  { clientId: 'c-caio', clientIds: ['c-caio'], userId: 'u-caio', name: 'Caio' },
  { clientId: 'c-dani', clientIds: ['c-dani'], userId: 'u-dani', name: 'Dani' },
  { clientId: 'c-lucas', clientIds: ['c-lucas'], userId: 'u-lucas', name: 'Lucas' },
];
const state = (votes: RoomState['votes'] = {}, version = 1): RoomState => ({
  roomId: 'R1',
  queue: [track('t1', 'Bia', 'u-bia'), track('t2', 'Caio', 'u-caio'), track('t3', 'Dani', 'u-dani')],
  nowPlayingId: 't1',
  radioEnabled: false,
  version,
  transport: { state: 'playing', positionMs: 1000, updatedAtServerMs: Date.now() },
  votes,
});

const W = 1440, H = 900, HUD = 60;
const props = { roomId: 'R1', queue: <div data-testid="queue-slot" />, chat: <div data-testid="chat-slot" />, queueCount: 2, hasPlayer: true, artwork: null };

const restore: Array<() => void> = [];
beforeAll(() => {
  const def = (proto: object, key: string, get: (this: HTMLElement) => number) => {
    const prev = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, get });
    restore.push(() => (prev ? Object.defineProperty(proto, key, prev) : delete (proto as Record<string, unknown>)[key]));
  };
  def(HTMLElement.prototype, 'clientWidth', () => W);
  def(HTMLElement.prototype, 'clientHeight', () => H);
  def(HTMLElement.prototype, 'offsetHeight', function () { return this.classList.contains('palco__hud') ? HUD : 20; });
  def(HTMLElement.prototype, 'offsetWidth', () => 80);
  const RO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  restore.push(() => { globalThis.ResizeObserver = RO; });
});
afterAll(() => restore.forEach((r) => r()));

beforeEach(() => {
  fake.FakeScene.last = null;
  fake.wootListeners.length = 0;
  fake.sendWoot.mockClear();
  fake.sendEmote.mockClear();
  fake.emoteListeners.length = 0;
  fake.advance.mockClear();
  fake.pause.mockClear();
  fake.play.mockClear();
  useStore.setState({ state: state(), clientId: 'c-lucas', chat: [], nameSuffixes: {} });
  useStore.getState().setMembers(MEMBERS);
  useStore.getState().setCharacterOverride('c-lucas', 5);
});

async function mount(extra: Partial<React.ComponentProps<typeof PalcoView>> = {}) {
  render(<PalcoView {...props} {...extra} />);
  await waitFor(() => expect(fake.FakeScene.last).not.toBeNull());
  return fake.FakeScene.last!;
}

describe('PalcoView', () => {
  it('puts the playing track adder at the left booth, the next one at the right, and the rest in the crowd', async () => {
    const scene = await mount();
    await waitFor(() => expect(scene.booths.at(-1)?.map((b) => b?.key)).toEqual(['u:u-bia', 'u:u-caio']));
    const crowd = scene.crowd.at(-1)!;
    expect(crowd.map((e) => e.key).sort()).toEqual(['u:u-dani', 'u:u-lucas']);
    expect(crowd.find((e) => e.key === 'u:u-lucas')?.characterId).toBe(5);
    expect(screen.getByText('Bia · tocando')).toBeTruthy();
    expect(screen.getByText('Caio · próxima')).toBeTruthy();
    expect(screen.getByText('Você').className).toContain('palco-tag--you');
  });

  it('woots a member who upvotes, a member whose reaction.woot arrives, and you on Curtir', async () => {
    const scene = await mount();
    act(() => useStore.getState().setState(state({ t3: ['user:u-dani'] }, 2)));
    expect(scene.woots).toEqual(['u:u-dani']);
    act(() => fake.wootListeners.forEach((l) => l('c-caio')));
    act(() => fake.wootListeners.forEach((l) => l('c-lucas'))); // our own echo: already shown
    expect(scene.woots).toEqual(['u:u-dani', 'u:u-caio']);
    fireEvent.click(screen.getByRole('button', { name: /Curtir/ }));
    expect(scene.woots).toEqual(['u:u-dani', 'u:u-caio', 'u:u-lucas']);
    expect(fake.sendWoot).toHaveBeenCalledWith('R1');
    expect(screen.getByLabelText('2 curtidas')).toBeTruthy();
  });

  it('shows a new chat line as a bubble over the sender, never over the screen', async () => {
    const scene = await mount();
    const line: ChatMessage = { id: 'm1', roomId: 'R1', name: 'Dani', userId: 'u-dani', text: 'que voz', sentAtServerMs: Date.now() };
    act(() => useStore.getState().addChatMessage(line));
    const bubble = await screen.findByText('que voz');
    const framing = frameStage(WORLDS.wide, W, H - HUD);
    const scr = screenRect(WORLDS.wide, framing);
    // Dani's head right under the middle of the screen: the bubble must move below it.
    const out: FrameOut = {
      people: new Map([['u:u-dani', { x: scr.x + scr.w / 2, y: scr.y + scr.h + 10, visible: true }], ['u:u-lucas', { x: 100, y: 600, visible: true }]]),
      booths: [{ key: 'u:u-bia', x: 50, y: 300, visible: true }, { key: 'u:u-caio', x: 1300, y: 300, visible: true }],
    };
    act(() => scene.listener?.(out));
    const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(bubble.style.transform);
    expect(m).not.toBeNull();
    const top = Number(m![2]);
    expect(top).toBeGreaterThanOrEqual(scr.y + scr.h);
    expect(bubble.style.visibility).toBe('visible');
    // Lines from before the view opened never pop up.
    expect(screen.queryByText('antes')).toBeNull();
  });

  it('"+ Música" opens the add form in the Fila panel without leaving palco, and Esc or a finished add returns to the stage', async () => {
    const onAddOpen = vi.fn();
    const onAddClose = vi.fn();
    const view = (addOpen: boolean) => <PalcoView {...props} addOpen={addOpen} onAddOpen={onAddOpen} onAddClose={onAddClose} />;
    const { rerender } = render(view(false));
    await waitFor(() => expect(fake.FakeScene.last).not.toBeNull());
    expect(screen.queryByTestId('queue-slot')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar música' }));
    expect(onAddOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('palco')).toBeTruthy();
    expect(screen.getByTestId('queue-slot')).toBeTruthy();
    rerender(view(true));
    fireEvent.keyDown(screen.getByTestId('queue-slot'), { key: 'Escape' });
    expect(onAddClose).toHaveBeenCalledTimes(1);
    rerender(view(false));
    expect(screen.queryByTestId('queue-slot')).toBeNull();
    // A finished add (the room turns addOpen off) also returns to the stage.
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar música' }));
    rerender(view(true));
    expect(screen.getByTestId('queue-slot')).toBeTruthy();
    rerender(view(false));
    expect(screen.queryByTestId('queue-slot')).toBeNull();
  });

  it('opens Fila and Chat as panels and keeps one at a time', async () => {
    await mount();
    expect(screen.queryByTestId('queue-slot')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Fila (2)' }));
    expect(screen.getByTestId('queue-slot')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.queryByTestId('queue-slot')).toBeNull();
    expect(screen.getByTestId('chat-slot')).toBeTruthy();
  });

  it('puts the volume, the service picker and, for who controls, pause and skip in the HUD', async () => {
    const player = { getCurrentPositionMs: async () => 4200 } as unknown as import('@/lib/playerInterface').IPlayer;
    await mount({ canControl: true, activePlayer: player, volume: <input aria-label="Volume" />, servicePicker: <div role="group" aria-label="Ouvir no" /> });
    const hud = screen.getByTestId('palco-hud');
    const ctrls = screen.getByRole('group', { name: 'Controles da música' });
    expect(hud.contains(ctrls)).toBe(true);
    expect(screen.getByLabelText('Volume')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Ouvir no' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima faixa' }));
    expect(fake.advance).toHaveBeenCalledWith('R1', 't1');
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(fake.pause).toHaveBeenCalledWith('R1', 4200));
  });

  it('shows no transport to who cannot control', async () => {
    await mount({ canControl: false, volume: <input aria-label="Volume" /> });
    expect(screen.queryByRole('button', { name: 'Próxima faixa' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pausar' })).toBeNull();
    expect(screen.getByLabelText('Volume')).toBeTruthy();
  });

  it('lists the next tracks on the "A seguir" board and hides it when nothing is queued', async () => {
    await mount();
    const board = screen.getByRole('region', { name: 'A seguir' });
    expect([...board.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['1Faixa t2 · Artista', '2Faixa t3 · Artista']);
    act(() => useStore.getState().setState({ ...state(undefined, 2), queue: [track('t1', 'Bia', 'u-bia')] }));
    expect(screen.queryByRole('region', { name: 'A seguir' })).toBeNull();
  });

  it('sends an emote from the reaction bar and shows emotes over the sender, ours once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mount();
      const bar = screen.getByRole('group', { name: 'Reações' });
      expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Amei', 'Fogo', 'Rindo', 'Palmas', 'Uau', 'Cantando']);
      fireEvent.click(screen.getByRole('button', { name: 'Fogo' }));
      expect(fake.sendEmote).toHaveBeenCalledWith('R1', 'fogo');
      // Cooling down: a second press within 600 ms sends nothing.
      fireEvent.click(screen.getByRole('button', { name: 'Uau' }));
      expect(fake.sendEmote).toHaveBeenCalledTimes(1);
      act(() => fake.emoteListeners.forEach((l) => l('c-lucas', 'fogo'))); // our own echo
      act(() => fake.emoteListeners.forEach((l) => l('c-dani', 'palmas')));
      expect([...document.querySelectorAll('.palco-emote')].map((el) => el.getAttribute('data-emote'))).toEqual(['fogo', 'palmas']);
      act(() => { vi.advanceTimersByTime(1600); });
      expect(document.querySelectorAll('.palco-emote')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('name tags', () => {
    const size = { w: window.innerWidth, h: window.innerHeight };
    afterEach(() => {
      Object.assign(window, { innerWidth: size.w, innerHeight: size.h });
    });
    const withNames = () => {
      useStore.getState().setMembers([
        ...MEMBERS,
        { clientId: 'c-me', clientIds: ['c-me'], userId: 'u-me', name: 'Maria Eduarda Albuquerque' },
      ]);
      useStore.setState({ nameSuffixes: { 'c-me': ' 2' } });
    };

    it('on phones shows the first name (and the namesake suffix), at least 70 CSS px wide', async () => {
      Object.assign(window, { innerWidth: 390, innerHeight: 844 });
      withNames();
      await mount();
      const tag = screen.getByText('Maria 2');
      expect(parseFloat(tag.style.maxWidth)).toBeGreaterThanOrEqual(70);
      expect(screen.queryByText(/Eduarda/)).toBeNull();
    });

    it('on the wide stage keeps the full name', async () => {
      Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
      withNames();
      await mount();
      expect(screen.getByText('Maria Eduarda Albuquerque 2')).toBeTruthy();
    });
  });

  describe('Reagir popup on phones', () => {
    const size = { w: window.innerWidth, h: window.innerHeight };
    beforeEach(() => {
      Object.assign(window, { innerWidth: 390, innerHeight: 844 });
    });
    afterAll(() => {
      Object.assign(window, { innerWidth: size.w, innerHeight: size.h });
    });

    it('closes on Escape and returns focus to the toggle', async () => {
      await mount();
      const toggle = screen.getByRole('button', { name: 'Reagir' });
      fireEvent.click(toggle);
      expect(screen.getByRole('group', { name: 'Reações' })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('group', { name: 'Reações' })).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it('closes on a pointerdown outside, stays open for one inside', async () => {
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'Reagir' }));
      const group = screen.getByRole('group', { name: 'Reações' });
      fireEvent.pointerDown(group);
      expect(screen.queryByRole('group', { name: 'Reações' })).toBeTruthy();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole('group', { name: 'Reações' })).toBeNull();
    });
  });
});
