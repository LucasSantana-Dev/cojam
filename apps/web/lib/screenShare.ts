// Screen share v1 (#310, docs/specs/310-screen-share.md): the WebRTC side.
//
// P2P mesh: the broadcaster holds one RTCPeerConnection per admitted viewer
// and is the only offerer, so there is no glare. The server relays SDP and
// ICE (rtc.signal) and never sees media. These classes take their transport
// and their RTCPeerConnection factory as arguments, so they run under Vitest
// with fakes and in the browser with the real thing.
import type { IceCandidateInit, SignalPayload } from '@cojam/shared';

export type SignalSender = (to: string, payload: SignalPayload) => Promise<void>;
export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection;

// Public STUN only (C5): no TURN until revenue (#262). STUN requests disclose
// the client's address to Google and Cloudflare; the privacy policy says so.
export const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

// iceServersFrom reads COJAM_STUN_URLS (comma-separated). Unset keeps the
// defaults; an explicitly empty value means no STUN at all (CI, where peers on
// one host connect over host candidates). Anything but stun: is dropped, so a
// config typo can never smuggle in a TURN relay.
export function iceServersFrom(raw: string | undefined): RTCIceServer[] {
  if (raw === undefined) return [{ urls: DEFAULT_STUN_URLS }];
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^stuns?:/i.test(u));
  return urls.length ? [{ urls }] : [];
}

// The capture constraints of spec 5.2. selfBrowserSurface and friends are
// Chromium hints; other browsers ignore unknown keys.
// displaySurface 'browser' opens the picker on the tab list: on macOS only a
// tab carries sound ("Compartilhar áudio da aba"), a window or the whole
// screen never does. Voice processing is off so music is not mangled.
export const DISPLAY_MEDIA_OPTIONS = {
  video: { frameRate: { ideal: 15, max: 30 }, height: { max: 720 }, displaySurface: 'browser' },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  systemAudio: 'include',
} as const;

export const MAX_BITRATE = 1_200_000;

// Quality presets the broadcaster picks, before sharing or live. The first
// is the spec 5.2 default (720p, 15 fps, 1.2 Mbps, sharp text). The others
// trade upload for detail or motion: the mesh sends one copy per viewer, so
// five viewers at "Máxima" need about 20 Mbps of upload.
export type ScreenQualityId = 'text' | 'hd' | 'smooth' | 'max';
export type ScreenQuality = {
  id: ScreenQualityId;
  label: string;
  detail: string;
  height: number;
  frameRate: number;
  maxBitrate: number;
  // true favours frame rate (video, games); false keeps resolution (text).
  motion: boolean;
};

export const SCREEN_QUALITIES: readonly ScreenQuality[] = [
  {
    id: 'text',
    label: 'Texto nítido',
    detail: '720p, 15 fps',
    height: 720,
    frameRate: 15,
    maxBitrate: MAX_BITRATE,
    motion: false,
  },
  {
    id: 'hd',
    label: 'Alta definição',
    detail: '1080p, 30 fps',
    height: 1080,
    frameRate: 30,
    maxBitrate: 2_500_000,
    motion: false,
  },
  {
    id: 'smooth',
    label: 'Movimento suave',
    detail: '720p, 60 fps',
    height: 720,
    frameRate: 60,
    maxBitrate: 2_500_000,
    motion: true,
  },
  {
    id: 'max',
    label: 'Máxima',
    detail: '1080p, 60 fps',
    height: 1080,
    frameRate: 60,
    maxBitrate: 4_000_000,
    motion: true,
  },
];

export const DEFAULT_QUALITY: ScreenQuality = SCREEN_QUALITIES[0];

export function qualityById(id: string | null | undefined): ScreenQuality {
  return SCREEN_QUALITIES.find((q) => q.id === id) ?? DEFAULT_QUALITY;
}

// The video constraints of one preset, for the picker and for applyConstraints
// on a live track.
export function videoConstraints(q: ScreenQuality): MediaTrackConstraints {
  return { frameRate: { ideal: q.frameRate, max: q.frameRate }, height: { max: q.height } };
}

export function displayMediaOptions(q: ScreenQuality) {
  return { ...DISPLAY_MEDIA_OPTIONS, video: { ...videoConstraints(q), displaySurface: 'browser' } };
}

// Upload the broadcaster needs with every seat taken, in Mbps.
export function uploadMbps(q: ScreenQuality, viewers: number): number {
  return Math.round(((q.maxBitrate * viewers) / 1_000_000) * 10) / 10;
}
export const CANDIDATE_BATCH_MS = 100;
export const MAX_CANDIDATES_PER_MESSAGE = 20;
export const VIEWER_CONNECT_TIMEOUT_MS = 15_000;

// CandidateBatcher trickles ICE candidates in short batches (spec 5.2.6): one
// rtc.signal per batch instead of one per candidate keeps a five-viewer join
// inside the server's rate limit.
export class CandidateBatcher {
  private pending: IceCandidateInit[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly flush: (payload: SignalPayload) => void,
    private readonly delayMs = CANDIDATE_BATCH_MS,
  ) {}

  // push queues one candidate; null is the end-of-candidates marker.
  push(c: RTCIceCandidate | RTCIceCandidateInit | null): void {
    if (this.closed) return;
    if (c === null) {
      this.drain();
      this.flush({ kind: 'end-of-candidates' });
      return;
    }
    if (!c.candidate) return; // the empty end-of-generation candidate
    this.pending.push({
      candidate: c.candidate,
      sdpMid: c.sdpMid ?? null,
      sdpMLineIndex: c.sdpMLineIndex ?? null,
      ...(c.usernameFragment ? { usernameFragment: c.usernameFragment } : {}),
    });
    if (this.pending.length >= MAX_CANDIDATES_PER_MESSAGE) {
      this.drain();
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => this.drain(), this.delayMs);
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.length) {
      const batch = this.pending.splice(0, MAX_CANDIDATES_PER_MESSAGE);
      this.flush({ kind: 'candidates', candidates: batch });
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}

// addCandidates applies a relayed batch, ignoring ones the browser rejects (a
// stale candidate after a restart is not worth tearing a peer down for).
async function addCandidates(pc: RTCPeerConnection, list: IceCandidateInit[]): Promise<void> {
  for (const c of list) {
    try {
      await pc.addIceCandidate(c);
    } catch {
      /* stale or malformed candidate: skip */
    }
  }
}

type BroadcasterPeer = { pc: RTCPeerConnection; batcher: CandidateBatcher };

// BroadcasterPeers owns the broadcaster's side of the mesh: one peer per
// admitted viewer, opened on the server's screen.viewer join notice.
export class BroadcasterPeers {
  private peers = new Map<string, BroadcasterPeer>();
  private stream: MediaStream;

  constructor(
    private readonly opts: {
      stream: MediaStream;
      send: SignalSender;
      createPeer: PeerFactory;
      iceServers: RTCIceServer[];
      onViewersChange?: (viewerIds: string[]) => void;
      batchMs?: number;
      quality?: ScreenQuality;
    },
  ) {
    this.stream = opts.stream;
    this.quality = opts.quality ?? DEFAULT_QUALITY;
  }

  private quality: ScreenQuality;

  // setQuality re-caps every viewer's video sender for a new preset. The
  // caller changes the track's own constraints.
  async setQuality(q: ScreenQuality): Promise<void> {
    this.quality = q;
    await Promise.all(
      [...this.peers.values()].map(({ pc }) => {
        const sender = senderFor(pc, 'video');
        return sender ? capSender(sender, q) : undefined;
      }),
    );
  }

  // limitation reports why the encoder is holding quality back on any peer
  // (spec 6): the uplink or the CPU. Null when nothing limits it.
  async limitation(): Promise<'bandwidth' | 'cpu' | null> {
    let found: 'bandwidth' | 'cpu' | null = null;
    for (const { pc } of this.peers.values()) {
      if (typeof pc.getStats !== 'function') continue;
      try {
        const stats = await pc.getStats();
        stats.forEach((r: { type?: string; kind?: string; qualityLimitationReason?: string }) => {
          if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
          if (r.qualityLimitationReason === 'bandwidth') found = 'bandwidth';
          else if (r.qualityLimitationReason === 'cpu' && !found) found = 'cpu';
        });
      } catch {
        /* closed meanwhile */
      }
    }
    return found;
  }

  viewers(): string[] {
    return [...this.peers.keys()];
  }

  // addViewer opens (or reopens) the peer for one viewer and sends the offer.
  // A repeated join for the same connection is a viewer retrying after a
  // failure, so the old peer is replaced.
  async addViewer(viewerId: string): Promise<void> {
    this.removeViewer(viewerId, false);
    const pc = this.opts.createPeer({ iceServers: this.opts.iceServers });
    const batcher = new CandidateBatcher((p) => void this.opts.send(viewerId, p).catch(() => {}), this.opts.batchMs);
    this.peers.set(viewerId, { pc, batcher });
    this.opts.onViewersChange?.(this.viewers());
    pc.onicecandidate = (e) => batcher.push(e.candidate);
    for (const track of this.stream.getTracks()) {
      const sender = pc.addTrack(track, this.stream);
      if (track.kind === 'video') void capSender(sender, this.quality);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.peers.get(viewerId)?.pc !== pc) return; // replaced or removed meanwhile
    await this.opts.send(viewerId, { kind: 'offer', sdp: offer.sdp ?? '' });
  }

  removeViewer(viewerId: string, notify = true): void {
    const peer = this.peers.get(viewerId);
    if (!peer) return;
    peer.batcher.close();
    peer.pc.onicecandidate = null;
    peer.pc.close();
    this.peers.delete(viewerId);
    if (notify) this.opts.onViewersChange?.(this.viewers());
  }

  async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return; // not a viewer we opened a peer for: ignore
    switch (payload.kind) {
      case 'answer':
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        break;
      case 'candidates':
        await addCandidates(peer.pc, payload.candidates);
        break;
      case 'bye':
        this.removeViewer(from);
        break;
      default:
        break; // offers never come from viewers; end-of-candidates needs nothing
    }
  }

  // replaceSource swaps the source on every peer ("Trocar o que compartilho",
  // spec 5.5). A kind the peer already sends is swapped in place; a kind it
  // never sent (sound added on the second try) is added and renegotiated with
  // a new offer on the same connection; a kind the new source lacks is muted.
  async replaceSource(stream: MediaStream): Promise<void> {
    this.stream = stream;
    for (const [viewerId, { pc }] of this.peers) {
      let renegotiate = false;
      for (const kind of ['video', 'audio'] as const) {
        const track = stream.getTracks().find((t) => t.kind === kind) ?? null;
        const sender = senderFor(pc, kind);
        if (sender) await sender.replaceTrack(track);
        else if (track) {
          const added = pc.addTrack(track, stream);
          if (kind === 'video') void capSender(added, this.quality);
          renegotiate = true;
        }
      }
      if (!renegotiate) continue;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.peers.get(viewerId)?.pc !== pc) continue;
      await this.opts.send(viewerId, { kind: 'offer', sdp: offer.sdp ?? '' });
    }
  }

  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.removeViewer(id, false);
    this.opts.onViewersChange?.([]);
  }
}

// senderFor finds the sender of one media kind, even after its track was
// swapped for null (the transceiver's receiver keeps the kind).
function senderFor(pc: RTCPeerConnection, kind: string): RTCRtpSender | undefined {
  const byTrack = pc.getSenders().find((s) => s.track?.kind === kind);
  if (byTrack || typeof pc.getTransceivers !== 'function') return byTrack;
  return pc.getTransceivers().find((t) => t.receiver.track?.kind === kind && t.currentDirection !== 'stopped')?.sender;
}

// capSender holds each viewer's stream at the preset's bitrate (1.2 Mbps by
// default). Text presets keep resolution, since text on a shared screen is
// unreadable when the encoder drops it; motion presets keep frame rate.
async function capSender(sender: RTCRtpSender, q: ScreenQuality = DEFAULT_QUALITY): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = q.maxBitrate;
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = q.motion
      ? 'maintain-framerate'
      : 'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    /* not supported here: keep the browser default */
  }
}

export type ViewerState = 'connecting' | 'connected' | 'failed' | 'closed';

// ViewerPeer is the viewer's single peer to the broadcaster. It answers the
// broadcaster's offer, reports the received stream, and gives up after one
// ICE restart or the connect timeout (there is no relay to fall back to).
export type ViewerHealth = 'frozen' | 'weak' | null;

export type InboundSample = { framesDecoded: number; packetsReceived: number; packetsLost: number };

// viewerHealth compares two inbound video samples taken a few seconds apart
// (spec 5.7). No decoded frame in between reads as a frozen image; under 5
// frames per second, or more than 5% of the packets lost, as a weak
// connection. The first sample has nothing to compare with.
export function viewerHealth(prev: InboundSample | null, cur: InboundSample, seconds: number): ViewerHealth {
  if (!prev || seconds <= 0) return null;
  const frames = cur.framesDecoded - prev.framesDecoded;
  if (frames <= 0) return 'frozen';
  const received = cur.packetsReceived - prev.packetsReceived;
  const lost = Math.max(0, cur.packetsLost - prev.packetsLost);
  if (frames / seconds < 5) return 'weak';
  if (received + lost > 0 && lost / (received + lost) > 0.05) return 'weak';
  return null;
}

export class ViewerPeer {
  private pc: RTCPeerConnection;
  private batcher: CandidateBatcher;
  private pendingCandidates: IceCandidateInit[] = [];
  private remoteSet = false;
  private remoteTracks: MediaStreamTrack[] = [];
  private restarted = false;
  private state: ViewerState = 'connecting';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      broadcasterId: string;
      send: SignalSender;
      createPeer: PeerFactory;
      iceServers: RTCIceServer[];
      onStream: (stream: MediaStream) => void;
      onState: (state: ViewerState) => void;
      connectTimeoutMs?: number;
      batchMs?: number;
    },
  ) {
    this.pc = opts.createPeer({ iceServers: opts.iceServers });
    this.batcher = new CandidateBatcher((p) => void opts.send(opts.broadcasterId, p).catch(() => {}), opts.batchMs);
    this.pc.onicecandidate = (e) => this.batcher.push(e.candidate);
    // One stream for everything received: a track added later (sound turned
    // on by a new source) arrives on a different remote stream id, and
    // replacing the stream with it would drop the video.
    this.pc.ontrack = (e) => {
      const tracks = this.remoteTracks.filter((t) => t.kind !== e.track.kind);
      tracks.push(e.track);
      this.remoteTracks = tracks;
      opts.onStream(new MediaStream(tracks));
    };
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    this.timer = setTimeout(() => {
      if (this.state === 'connecting') this.fail();
    }, opts.connectTimeoutMs ?? VIEWER_CONNECT_TIMEOUT_MS);
  }

  get broadcasterId(): string {
    return this.opts.broadcasterId;
  }

  private lastSample: { at: number; sample: InboundSample } | null = null;

  // health reads the inbound video stats and compares them with the last
  // read. Call it on a timer while connected.
  async health(nowMs = Date.now()): Promise<ViewerHealth> {
    if (this.state !== 'connected' || typeof this.pc.getStats !== 'function') return null;
    let sample: InboundSample | null = null;
    try {
      const stats = await this.pc.getStats();
      stats.forEach((r: { type?: string; kind?: string } & Partial<InboundSample>) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        sample = {
          framesDecoded: r.framesDecoded ?? 0,
          packetsReceived: r.packetsReceived ?? 0,
          packetsLost: r.packetsLost ?? 0,
        };
      });
    } catch {
      return null;
    }
    if (!sample) return null;
    const prev = this.lastSample;
    this.lastSample = { at: nowMs, sample };
    return viewerHealth(prev?.sample ?? null, sample, prev ? (nowMs - prev.at) / 1000 : 0);
  }

  private setState(s: ViewerState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }

  private onConnectionState(): void {
    const s = this.pc.connectionState;
    if (s === 'connected') {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.setState('connected');
    } else if (s === 'failed') {
      if (!this.restarted) {
        // One ICE restart (spec 5.3.5). The broadcaster is the offerer, so a
        // viewer-side restart only re-gathers; a real recovery needs a new
        // offer, which a re-watch triggers.
        this.restarted = true;
        try {
          this.pc.restartIce();
        } catch {
          this.fail();
        }
        return;
      }
      this.fail();
    }
  }

  private fail(): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.setState('failed');
    this.teardown();
  }

  async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    if (from !== this.opts.broadcasterId || this.state === 'closed' || this.state === 'failed') return;
    switch (payload.kind) {
      case 'offer': {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        this.remoteSet = true;
        const pending = this.pendingCandidates;
        this.pendingCandidates = [];
        await addCandidates(this.pc, pending);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.opts.send(this.opts.broadcasterId, { kind: 'answer', sdp: answer.sdp ?? '' });
        break;
      }
      case 'candidates':
        if (this.remoteSet) await addCandidates(this.pc, payload.candidates);
        else this.pendingCandidates.push(...payload.candidates);
        break;
      case 'bye':
        this.close();
        break;
      default:
        break;
    }
  }

  private teardown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.batcher.close();
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }

  close(): void {
    if (this.state === 'closed') return;
    const wasFailed = this.state === 'failed';
    this.state = 'closed';
    if (!wasFailed) this.teardown();
    this.opts.onState('closed');
  }
}
