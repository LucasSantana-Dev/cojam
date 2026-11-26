import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IceCandidateInit, SignalPayload } from '@cojam/shared';
import {
  BroadcasterPeers,
  CandidateBatcher,
  DEFAULT_STUN_URLS,
  MAX_BITRATE,
  ViewerPeer,
  iceServersFrom,
  type ViewerState,
} from './screenShare';

// A fake RTCPeerConnection with just what the peer classes touch.
class FakeSender {
  params: { encodings?: { maxBitrate?: number }[]; degradationPreference?: string } = { encodings: [] };
  constructor(public track: { kind: string; id: string } | null) {}
  getParameters() {
    return this.params;
  }
  async setParameters(p: FakeSender['params']) {
    this.params = p;
  }
  async replaceTrack(t: { kind: string; id: string }) {
    this.track = t;
  }
}

class FakePC {
  static all: FakePC[] = [];
  onicecandidate: ((e: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ontrack: ((e: { streams: unknown[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  senders: FakeSender[] = [];
  remote: RTCSessionDescriptionInit | null = null;
  local: RTCSessionDescriptionInit | null = null;
  added: RTCIceCandidateInit[] = [];
  closed = false;
  restarts = 0;
  constructor(public config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  addTrack(track: { kind: string; id: string }) {
    const s = new FakeSender(track);
    this.senders.push(s);
    return s;
  }
  getSenders() {
    return this.senders;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0 answer' };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.local = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remote = d;
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    if (c.candidate === 'bad') throw new Error('bad candidate');
    this.added.push(c);
  }
  restartIce() {
    this.restarts++;
  }
  close() {
    this.closed = true;
  }
  setState(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

const factory = (config: RTCConfiguration) => new FakePC(config) as unknown as RTCPeerConnection;

function fakeStream(kinds: string[]) {
  const tracks = kinds.map((kind, i) => ({ kind, id: `${kind}-${i}` }));
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

const cand = (n: number): IceCandidateInit => ({ candidate: `candidate:${n}`, sdpMid: '0', sdpMLineIndex: 0 });

beforeEach(() => {
  FakePC.all = [];
});

describe('iceServersFrom', () => {
  it('defaults to the public STUN pair when unset', () => {
    expect(iceServersFrom(undefined)).toEqual([{ urls: DEFAULT_STUN_URLS }]);
  });

  it('means no STUN at all when set empty', () => {
    expect(iceServersFrom('')).toEqual([]);
  });

  it('keeps only stun: URLs, so a typo can never add a TURN relay', () => {
    expect(iceServersFrom(' stun:a.example:3478 , turn:relay.example, stuns:b.example ')).toEqual([
      { urls: ['stun:a.example:3478', 'stuns:b.example'] },
    ]);
    expect(iceServersFrom('turn:relay.example')).toEqual([]);
  });
});

describe('CandidateBatcher', () => {
  afterEach(() => vi.useRealTimers());

  it('sends one message per batch window', () => {
    vi.useFakeTimers();
    const sent: SignalPayload[] = [];
    const b = new CandidateBatcher((p) => sent.push(p), 100);
    b.push(cand(1));
    b.push(cand(2));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([{ kind: 'candidates', candidates: [cand(1), cand(2)] }]);
  });

  it('flushes at 20 candidates and never sends more per message', () => {
    vi.useFakeTimers();
    const sent: SignalPayload[] = [];
    const b = new CandidateBatcher((p) => sent.push(p), 100);
    for (let i = 0; i < 25; i++) b.push(cand(i));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
    for (const p of sent) if (p.kind === 'candidates') expect(p.candidates.length).toBeLessThanOrEqual(20);
  });

  it('drains then marks the end on a null candidate, skips empty ones, and goes quiet when closed', () => {
    vi.useFakeTimers();
    const sent: SignalPayload[] = [];
    const b = new CandidateBatcher((p) => sent.push(p), 100);
    b.push(cand(1));
    b.push({ candidate: '' });
    b.push(null);
    expect(sent).toEqual([{ kind: 'candidates', candidates: [cand(1)] }, { kind: 'end-of-candidates' }]);
    b.close();
    b.push(cand(2));
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(2);
  });
});

describe('BroadcasterPeers', () => {
  function rig() {
    const sent: { to: string; payload: SignalPayload }[] = [];
    const viewers: string[][] = [];
    const peers = new BroadcasterPeers({
      stream: fakeStream(['video', 'audio']),
      send: async (to, payload) => {
        sent.push({ to, payload });
      },
      createPeer: factory,
      iceServers: [],
      onViewersChange: (v) => viewers.push(v),
      batchMs: 1,
    });
    return { peers, sent, viewers };
  }

  it('opens one peer per viewer, adds every track, caps the video sender and offers', async () => {
    const { peers, sent, viewers } = rig();
    await peers.addViewer('v1');
    const pc = FakePC.all[0];
    expect(pc.senders.map((s) => s.track?.kind)).toEqual(['video', 'audio']);
    await Promise.resolve();
    expect(pc.senders[0].params.encodings?.[0].maxBitrate).toBe(MAX_BITRATE);
    expect(pc.senders[0].params.degradationPreference).toBe('maintain-resolution');
    expect(sent).toEqual([{ to: 'v1', payload: { kind: 'offer', sdp: 'v=0 offer' } }]);
    expect(viewers.at(-1)).toEqual(['v1']);
  });

  it('replaces the peer when the same viewer joins again', async () => {
    const { peers } = rig();
    await peers.addViewer('v1');
    await peers.addViewer('v1');
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(peers.viewers()).toEqual(['v1']);
  });

  it('applies answers and candidates only from viewers it opened a peer for', async () => {
    const { peers } = rig();
    await peers.addViewer('v1');
    const pc = FakePC.all[0];
    await peers.handleSignal('v1', { kind: 'answer', sdp: 'v=0 answer' });
    await peers.handleSignal('v1', { kind: 'candidates', candidates: [cand(1), { candidate: 'bad' }, cand(2)] });
    await peers.handleSignal('stranger', { kind: 'answer', sdp: 'v=0 forged' });
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(pc.added).toEqual([cand(1), cand(2)]);
  });

  it('closes the peer on bye and on removeViewer, and everything on closeAll', async () => {
    const { peers, viewers } = rig();
    await peers.addViewer('v1');
    await peers.addViewer('v2');
    await peers.handleSignal('v1', { kind: 'bye' });
    expect(FakePC.all[0].closed).toBe(true);
    expect(peers.viewers()).toEqual(['v2']);
    peers.closeAll();
    expect(FakePC.all[1].closed).toBe(true);
    expect(viewers.at(-1)).toEqual([]);
  });

  it('swaps the video track on every peer for a new source', async () => {
    const { peers } = rig();
    await peers.addViewer('v1');
    await peers.addViewer('v2');
    await peers.replaceSource(fakeStream(['video']));
    for (const pc of FakePC.all) expect(pc.senders[0].track?.id).toBe('video-0');
    await peers.addViewer('v3');
    expect(FakePC.all[2].senders.map((s) => s.track?.kind)).toEqual(['video']);
  });

  it('trickles candidates to the right viewer', async () => {
    const { peers, sent } = rig();
    await peers.addViewer('v1');
    FakePC.all[0].onicecandidate?.({ candidate: null });
    expect(sent.at(-1)).toEqual({ to: 'v1', payload: { kind: 'end-of-candidates' } });
  });
});

describe('ViewerPeer', () => {
  afterEach(() => vi.useRealTimers());

  function rig(timeoutMs = 15_000) {
    const sent: { to: string; payload: SignalPayload }[] = [];
    const states: ViewerState[] = [];
    const streams: MediaStream[] = [];
    const peer = new ViewerPeer({
      broadcasterId: 'b1',
      send: async (to, payload) => {
        sent.push({ to, payload });
      },
      createPeer: factory,
      iceServers: [],
      onStream: (s) => streams.push(s),
      onState: (s) => states.push(s),
      connectTimeoutMs: timeoutMs,
      batchMs: 1,
    });
    return { peer, pc: FakePC.all[0], sent, states, streams };
  }

  it('answers the broadcaster offer, applying candidates queued before it', async () => {
    const { peer, pc, sent } = rig();
    await peer.handleSignal('b1', { kind: 'candidates', candidates: [cand(1)] });
    expect(pc.added).toEqual([]);
    await peer.handleSignal('b1', { kind: 'offer', sdp: 'v=0 offer' });
    expect(pc.remote).toEqual({ type: 'offer', sdp: 'v=0 offer' });
    expect(pc.added).toEqual([cand(1)]);
    expect(sent).toEqual([{ to: 'b1', payload: { kind: 'answer', sdp: 'v=0 answer' } }]);
    await peer.handleSignal('b1', { kind: 'candidates', candidates: [cand(2)] });
    expect(pc.added).toEqual([cand(1), cand(2)]);
    peer.close();
  });

  it('ignores signals from anyone but the broadcaster', async () => {
    const { peer, pc, sent } = rig();
    await peer.handleSignal('someone', { kind: 'offer', sdp: 'v=0 forged' });
    expect(pc.remote).toBeNull();
    expect(sent).toEqual([]);
    peer.close();
  });

  it('reports the received stream and the connected state', () => {
    const { peer, pc, states, streams } = rig();
    const stream = fakeStream(['video']);
    pc.ontrack?.({ streams: [stream], track: {} });
    pc.setState('connected');
    expect(streams).toEqual([stream]);
    expect(states).toEqual(['connected']);
    peer.close();
    expect(states.at(-1)).toBe('closed');
    expect(pc.closed).toBe(true);
  });

  it('restarts ICE once, then fails', () => {
    const { pc, states } = rig();
    pc.setState('failed');
    expect(pc.restarts).toBe(1);
    expect(states).toEqual([]);
    pc.setState('failed');
    expect(states).toEqual(['failed']);
    expect(pc.closed).toBe(true);
  });

  it('fails when nothing connects before the timeout', () => {
    vi.useFakeTimers();
    const { pc, states } = rig(1000);
    vi.advanceTimersByTime(1000);
    expect(states).toEqual(['failed']);
    expect(pc.closed).toBe(true);
  });

  it('stops on bye and drops later signals', async () => {
    const { peer, pc, states, sent } = rig();
    await peer.handleSignal('b1', { kind: 'bye' });
    expect(states).toEqual(['closed']);
    await peer.handleSignal('b1', { kind: 'offer', sdp: 'v=0 offer' });
    expect(pc.remote).toBeNull();
    expect(sent).toEqual([]);
  });
});
