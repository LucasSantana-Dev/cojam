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
    },
  ) {
    this.stream = opts.stream;
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
      if (track.kind === 'video') void capSender(sender);
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
          if (kind === 'video') void capSender(added);
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

// capSender holds each viewer's stream at 1.2 Mbps and favours resolution:
// text on a shared screen is unreadable when the encoder drops resolution.
async function capSender(sender: RTCRtpSender): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_BITRATE;
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch {
    /* not supported here: keep the browser default */
  }
}

export type ViewerState = 'connecting' | 'connected' | 'failed' | 'closed';

// ViewerPeer is the viewer's single peer to the broadcaster. It answers the
// broadcaster's offer, reports the received stream, and gives up after one
// ICE restart or the connect timeout (there is no relay to fall back to).
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
