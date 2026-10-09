// Keeping the music going while the tab is in the background.
//
// Hidden tabs get their timers throttled (1 s, then once a minute after a few
// minutes) and may even be frozen, so playback must never wait on a timer
// alone. Three rules live here:
//  1. Anything the browser or player did to the audio while hidden is undone
//     from the player's own events, not from the next throttled tick.
//  2. When the page comes back (visible, thawed, back online) everything is
//     re-checked at once, without waiting for the next tick.
//  3. A track-end advance that fails (the socket was mid-reconnect) is retried
//     instead of dropped.
// Nothing here pauses playback on visibilitychange: only visuals do that.

// YT.PlayerState: UNSTARTED -1, ENDED 0, PLAYING 1, PAUSED 2, BUFFERING 3, CUED 5.
const YT_UNSTARTED = -1;
const YT_PAUSED = 2;
const YT_CUED = 5;

// True when the YouTube player stopped by itself while the room is playing and
// nobody is looking at the page (so nobody paused it on purpose): the browser or
// the embed paused it, or a load in the background landed on cued/unstarted.
// A pause the room asked for arrives as a transport change first, so the
// transport is no longer 'playing' by then.
export function shouldResumeInBackground(args: {
  ytState: number;
  hidden: boolean;
  transportState: string | undefined;
  muted: boolean;
}): boolean {
  if (args.muted || !args.hidden || args.transportState !== 'playing') return false;
  return args.ytState === YT_PAUSED || args.ytState === YT_UNSTARTED || args.ytState === YT_CUED;
}

// Calls onResume whenever the page may have just come back: tab shown, thawed
// from a freeze, restored from the back/forward cache, network back. Calls
// closer than RESUME_DEBOUNCE_MS apart collapse into one (several events fire
// together). Window focus is left out on purpose: it fires on every alt-tab.
// Returns the cleanup.
export const RESUME_DEBOUNCE_MS = 2000;

export function attachResumeListeners(
  onResume: () => void,
  doc: Document = document,
  win: Window = window,
): () => void {
  let last = -Infinity;
  const fire = () => {
    const now = Date.now();
    if (now - last < RESUME_DEBOUNCE_MS) return;
    last = now;
    onResume();
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') fire();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('resume', fire);
  win.addEventListener('pageshow', fire);
  win.addEventListener('online', fire);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('resume', fire);
    win.removeEventListener('pageshow', fire);
    win.removeEventListener('online', fire);
  };
}

export const ADVANCE_RETRIES = 3;
export const ADVANCE_RETRY_DELAY_MS = 2000;

// Advances the room past a finished track. A permission denial is final (a
// listener's rejection is expected); any other failure (socket reconnecting,
// timeout) is retried while that track is still the one playing.
export async function advanceWithRetry(
  advance: (roomId: string, afterId: string) => Promise<void>,
  getNowPlayingId: () => string | undefined,
  roomId: string,
  trackId: string,
  isFinalError: (err: unknown) => boolean,
  retries = ADVANCE_RETRIES,
  delayMs = ADVANCE_RETRY_DELAY_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await advance(roomId, trackId);
      return;
    } catch (err) {
      if (isFinalError(err)) return;
      if (attempt >= retries) {
        console.warn('[player] advance at track end failed:', err);
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      if (getNowPlayingId() !== trackId) return; // the room moved on by itself
    }
  }
}
