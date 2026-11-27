'use client';

import { useStore } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';

// Who is live in the room, for the "ao vivo" badge on their avatar (Go Live
// gap 2). Null while screen share is off for this page or nobody shares.
export function useLiveBroadcaster(): string | null {
  const f = useRuntimeFeatures();
  const id = useStore((s) => s.state?.screen?.broadcasterId);
  return f.screenShare && f.roomAuth && id ? id : null;
}

// A shortcut elsewhere in the room (the badge, the start notice) asks the
// screen share panel to watch. The panel runs its own flow, 16+ dialog
// included, so a shortcut never opens a connection by itself.
const WATCH_EVENT = 'cojam:screen-watch';

export function requestWatch(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WATCH_EVENT));
}

export function onWatchRequest(cb: () => void): () => void {
  window.addEventListener(WATCH_EVENT, cb);
  return () => window.removeEventListener(WATCH_EVENT, cb);
}
