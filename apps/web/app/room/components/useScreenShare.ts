'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '@cojam/shared';
import {
  onServerMessage,
  rpcErrorMessage,
  rtcSignal,
  screenLock,
  screenRefuse,
  screenStart,
  screenStop,
  screenUnwatch,
  screenWatch,
  useStore,
} from '@/lib/realtime';
import {
  BroadcasterPeers,
  ViewerPeer,
  displayMediaOptions,
  iceServersFrom,
  qualityById,
  videoConstraints,
  type ScreenQuality,
  type ScreenQualityId,
  type ViewerHealth,
  type ViewerState,
} from '@/lib/screenShare';
import { getRuntimeEnv } from '@/lib/runtimeEnv';
import { trackError, trackEvent } from '@/lib/telemetry';

// Screen share controller (#310, spec 5.2 and 5.3). Owns the captured stream,
// the broadcaster's peers or the viewer's peer, and reacts to the server's
// per-connection messages. The room state (state.screen) is the source of
// truth for whether a share is live; this hook only holds what is local.

export type ScreenRole = 'idle' | 'broadcasting' | 'watching';

export function canCaptureScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

function iceServers(): RTCIceServer[] {
  return iceServersFrom(getRuntimeEnv()?.stunUrls);
}

const createPeer = (config: RTCConfiguration) => new RTCPeerConnection(config);

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

const QUALITY_KEY = 'cojam.screenQuality';

function savedQuality(): ScreenQuality {
  try {
    return qualityById(localStorage.getItem(QUALITY_KEY));
  } catch {
    return qualityById(null);
  }
}

// How often the broadcaster checks whether the uplink or CPU holds quality back.
const LIMITATION_CHECK_MS = 5_000;

async function capture(quality: ScreenQuality): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(
      displayMediaOptions(quality) as unknown as DisplayMediaStreamOptions,
    );
    const video = stream.getVideoTracks()[0];
    if (video && 'contentHint' in video) video.contentHint = quality.motion ? 'motion' : 'detail';
    return stream;
  } catch {
    // A cancelled picker (NotAllowedError) or no permission: back to idle.
    trackEvent('screen_capture_denied');
    return null;
  }
}

export function useScreenShare(roomId: string) {
  const screen = useStore((s) => s.state?.screen);
  const myClientId = useStore((s) => s.clientId);
  const connected = useStore((s) => s.connected);

  const [role, setRole] = useState<ScreenRole>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState | null>(null);
  const [viewerIds, setViewerIds] = useState<string[]>([]);
  // When the last share this person watched ended; "Denunciar transmissão"
  // stays available for 10 minutes after (spec 5.6).
  const [lastWatchedAt, setLastWatchedAt] = useState<number | null>(null);
  const [quality, setQualityState] = useState<ScreenQuality>(savedQuality);
  // Why the encoder is holding quality back (spec 6), while broadcasting.
  const [limitation, setLimitation] = useState<'bandwidth' | 'cpu' | null>(null);
  // Whether the image a viewer gets froze or the connection is weak (spec 5.7).
  const [health, setHealth] = useState<ViewerHealth>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<BroadcasterPeers | null>(null);
  const viewerRef = useRef<ViewerPeer | null>(null);
  // True once a room state showed our own share. The start RPC can resolve
  // before that state arrives, so "no share in the state" only ends a
  // broadcast that the state had already confirmed.
  const confirmedRef = useRef(false);

  // Local teardown only: the server already knows (or will on disconnect).
  const dropBroadcast = useCallback((message = '') => {
    peersRef.current?.closeAll();
    peersRef.current = null;
    confirmedRef.current = false;
    stopStream(streamRef.current);
    streamRef.current = null;
    setLocalStream(null);
    setViewerIds([]);
    setLimitation(null);
    setRole((r) => (r === 'broadcasting' ? 'idle' : r));
    if (message) setNotice(message);
  }, []);

  const dropViewer = useCallback((message = '') => {
    const peer = viewerRef.current;
    viewerRef.current = null;
    peer?.close();
    if (peer) setLastWatchedAt(Date.now());
    setRemoteStream(null);
    setViewerState(null);
    setHealth(null);
    setRole((r) => (r === 'watching' ? 'idle' : r));
    if (message) setNotice(message);
  }, []);

  // Server messages for this connection.
  useEffect(() => {
    return onServerMessage((msg: ServerMessage) => {
      if (msg.roomId !== roomId) return;
      switch (msg.type) {
        case 'rtc.signal':
          if (peersRef.current) void peersRef.current.handleSignal(msg.from, msg.payload).catch(() => {});
          else if (viewerRef.current) void viewerRef.current.handleSignal(msg.from, msg.payload).catch(() => {});
          break;
        case 'screen.viewer':
          if (peersRef.current) {
            if (msg.action === 'join') void peersRef.current.addViewer(msg.clientId).catch(() => {});
            else peersRef.current.removeViewer(msg.clientId);
          } else if (viewerRef.current && msg.action === 'leave' && msg.clientId === useStore.getState().clientId) {
            dropViewer('Você saiu desta transmissão.');
          }
          break;
        case 'screen.ended':
          if (peersRef.current) dropBroadcast('O compartilhamento de tela terminou.');
          if (viewerRef.current) dropViewer('A transmissão terminou.');
          break;
      }
    });
  }, [roomId, dropBroadcast, dropViewer]);

  // Spec 5.2.10 and 5.3.6: a state without the share, a share that is not
  // ours, or any disconnect closes every peer. Adjusting during render would
  // touch refs, so this runs as an effect on the inputs that matter.
  useEffect(() => {
    if (!connected) {
      if (peersRef.current) dropBroadcast('A conexão caiu e o compartilhamento terminou.');
      if (viewerRef.current) dropViewer('A conexão caiu e a transmissão foi fechada.');
      return;
    }
    if (peersRef.current && screen?.broadcasterId === myClientId) confirmedRef.current = true;
    if (peersRef.current && confirmedRef.current && screen && screen.broadcasterId !== myClientId) {
      dropBroadcast('O compartilhamento continuou em outra aba.');
    }
    if (peersRef.current && confirmedRef.current && !screen) dropBroadcast();
    if (viewerRef.current && (!screen || screen.broadcasterId !== viewerRef.current.broadcasterId)) {
      dropViewer('A transmissão terminou.');
    }
  }, [connected, screen, myClientId, dropBroadcast, dropViewer]);

  // The viewer checks the incoming image on the same cadence as the
  // broadcaster's limit check.
  useEffect(() => {
    if (role !== 'watching' || viewerState !== 'connected') return;
    const t = setInterval(() => {
      const peer = viewerRef.current;
      if (!peer) return;
      void peer.health().then((h) => {
        if (viewerRef.current === peer) setHealth(h);
      });
    }, LIMITATION_CHECK_MS);
    return () => clearInterval(t);
  }, [role, viewerState]);

  // Unmount (leaving the room): close everything and tell the server.
  useEffect(() => {
    return () => {
      if (peersRef.current) void screenStop(roomId).catch(() => {});
      if (viewerRef.current) void screenUnwatch(roomId).catch(() => {});
      peersRef.current?.closeAll();
      peersRef.current = null;
      viewerRef.current?.close();
      viewerRef.current = null;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [roomId]);

  const send = useCallback(
    (to: string, payload: Parameters<typeof rtcSignal>[2]) => rtcSignal(roomId, to, payload),
    [roomId],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await screenStop(roomId);
    } catch {
      /* the local teardown below is what matters to this person */
    } finally {
      dropBroadcast();
      setBusy(false);
    }
  }, [roomId, dropBroadcast]);

  // The picker must open inside the click, before any await on the network.
  const start = useCallback(async () => {
    if (busy || peersRef.current) return;
    setError('');
    setNotice('');
    const stream = await capture(quality);
    if (!stream) return;
    setBusy(true);
    const peers = new BroadcasterPeers({
      stream,
      send,
      createPeer,
      iceServers: iceServers(),
      onViewersChange: setViewerIds,
      quality,
    });
    peersRef.current = peers;
    streamRef.current = stream;
    try {
      await screenStart(roomId);
      setLocalStream(stream);
      setRole('broadcasting');
      // The browser's own "Parar de compartilhar" ends the track (5.2.9).
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (peersRef.current === peers) void stop();
      });
    } catch (err) {
      peers.closeAll();
      peersRef.current = null;
      stopStream(stream);
      streamRef.current = null;
      setError(rpcErrorMessage(err, 'Não foi possível compartilhar a tela.'));
    } finally {
      setBusy(false);
    }
  }, [busy, roomId, send, stop, quality]);

  const changeSource = useCallback(async () => {
    const peers = peersRef.current;
    if (!peers) return;
    const next = await capture(quality);
    if (!next) return;
    if (peersRef.current !== peers) {
      stopStream(next);
      return;
    }
    await peers.replaceSource(next).catch(() => {});
    stopStream(streamRef.current);
    streamRef.current = next;
    setLocalStream(next);
    next.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (peersRef.current === peers && streamRef.current === next) void stop();
    });
  }, [stop, quality]);

  // A new preset applies at once while sharing: the track's own constraints
  // and every viewer's encoder cap.
  const setQuality = useCallback(async (id: ScreenQualityId) => {
    const next = qualityById(id);
    setQualityState(next);
    try {
      localStorage.setItem(QUALITY_KEY, next.id);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
    const video = streamRef.current?.getVideoTracks()[0];
    if (video) {
      if ('contentHint' in video) video.contentHint = next.motion ? 'motion' : 'detail';
      await video.applyConstraints?.(videoConstraints(next)).catch(() => {});
    }
    await peersRef.current?.setQuality(next).catch(() => {});
  }, []);

  // Spec 6: tell the broadcaster when the uplink or the CPU is the limit.
  useEffect(() => {
    if (role !== 'broadcasting') return;
    const t = setInterval(() => {
      const peers = peersRef.current;
      if (!peers) return;
      void peers.limitation().then((l) => {
        if (peersRef.current === peers) setLimitation(l);
      });
    }, LIMITATION_CHECK_MS);
    return () => clearInterval(t);
  }, [role]);

  const watch = useCallback(async () => {
    if (!screen || viewerRef.current || busy) return;
    setError('');
    setNotice('');
    setBusy(true);
    const broadcasterId = screen.broadcasterId;
    // The peer exists before the RPC so an offer that arrives before the
    // reply still finds it.
    const peer = new ViewerPeer({
      broadcasterId,
      send,
      createPeer,
      iceServers: iceServers(),
      onStream: setRemoteStream,
      onState: (s) => {
        if (viewerRef.current !== peer) return;
        setViewerState(s);
        if (s === 'connected') trackEvent('screen_ice_connected');
        if (s === 'failed') {
          trackError('screen_ice_failed');
          void screenUnwatch(roomId).catch(() => {});
        }
      },
    });
    viewerRef.current = peer;
    setViewerState('connecting');
    setRole('watching');
    try {
      await screenWatch(roomId);
    } catch (err) {
      viewerRef.current = null;
      peer.close();
      setViewerState(null);
      setRole('idle');
      setError(rpcErrorMessage(err, 'Não foi possível assistir agora.'));
    } finally {
      setBusy(false);
    }
  }, [screen, busy, roomId, send]);

  const unwatch = useCallback(async () => {
    dropViewer();
    await screenUnwatch(roomId).catch(() => {});
  }, [roomId, dropViewer]);

  const retryWatch = useCallback(async () => {
    dropViewer();
    await screenUnwatch(roomId).catch(() => {});
    await watch();
  }, [roomId, dropViewer, watch]);

  const lock = useCallback(
    async (locked: boolean) => {
      setError('');
      try {
        await screenLock(roomId, locked);
      } catch (err) {
        setError(rpcErrorMessage(err, 'Não foi possível mudar a entrada.'));
      }
    },
    [roomId],
  );

  const refuse = useCallback(
    async (clientId: string) => {
      setError('');
      try {
        await screenRefuse(roomId, clientId);
      } catch (err) {
        setError(rpcErrorMessage(err, 'Não foi possível remover essa pessoa da transmissão.'));
      }
    },
    [roomId],
  );

  return {
    screen,
    role,
    busy,
    error,
    notice,
    localStream,
    remoteStream,
    viewerState,
    viewerIds,
    lastWatchedAt,
    quality,
    setQuality,
    limitation,
    health,
    isBroadcaster: Boolean(screen && screen.broadcasterId === myClientId),
    start,
    stop,
    changeSource,
    watch,
    unwatch,
    retryWatch,
    lock,
    refuse,
  };
}
