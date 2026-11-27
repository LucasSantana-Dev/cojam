// Playback diagnostics: a short, local record of what the page and the player
// did, to explain a stop nobody can reproduce on demand (music stopping in a
// minimized window). It never leaves the browser: it lives in localStorage and
// is read by hand from the console with `copy(cojamPlaybackLog())`.
//
// Entries carry times, page visibility, player and transport states only: no
// room id, track id, name or URL (a room id is a capability).

const KEY = 'cojam.playbackLog';
export const PLAYBACK_LOG_MAX = 400;

export type PlaybackLogEntry = { t: number; ev: string; [k: string]: string | number | boolean | null };

let buffer: PlaybackLogEntry[] | null = null;

function load(): PlaybackLogEntry[] {
  if (buffer) return buffer;
  buffer = [];
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) buffer = parsed.slice(-PLAYBACK_LOG_MAX) as PlaybackLogEntry[];
  } catch {
    /* storage blocked or corrupt: start empty */
  }
  return buffer;
}

function save(entries: PlaybackLogEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage blocked or full: keep the in-memory copy */
  }
}

function pageState(): { hidden: boolean; focus: boolean } {
  if (typeof document === 'undefined') return { hidden: false, focus: false };
  let focus = false;
  try {
    focus = document.hasFocus();
  } catch {
    /* not available */
  }
  return { hidden: document.visibilityState === 'hidden', focus };
}

export function logPlayback(ev: string, data: Record<string, string | number | boolean | null | undefined> = {}): void {
  const entries = load();
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = v;
  entries.push({ t: Date.now(), ev, ...pageState(), ...clean });
  if (entries.length > PLAYBACK_LOG_MAX) entries.splice(0, entries.length - PLAYBACK_LOG_MAX);
  save(entries);
}

export function readPlaybackLog(): PlaybackLogEntry[] {
  return [...load()];
}

// One line per entry: local time, event, then the fields.
export function formatPlaybackLog(entries: PlaybackLogEntry[] = readPlaybackLog()): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const lines = entries.map(({ t, ev, ...rest }) => {
    const time = new Date(t).toISOString().slice(11, 23);
    const fields = Object.entries(rest)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return `${time} ${ev} ${fields}`;
  });
  return [`cojam playback log (${entries.length}) ${ua}`, ...lines].join('\n');
}

// YT.PlayerState names, for a readable log.
export function ytStateName(state: number): string {
  switch (state) {
    case -1:
      return 'unstarted';
    case 0:
      return 'ended';
    case 1:
      return 'playing';
    case 2:
      return 'paused';
    case 3:
      return 'buffering';
    case 5:
      return 'cued';
    default:
      return String(state);
  }
}

let pageListeners = false;

// Records the page lifecycle once per page load and exposes the console reader.
export function installPlaybackLog(): void {
  if (pageListeners || typeof window === 'undefined') return;
  pageListeners = true;
  (window as unknown as { cojamPlaybackLog?: () => string }).cojamPlaybackLog = () => formatPlaybackLog();
  logPlayback('page_open');
  document.addEventListener('visibilitychange', () => logPlayback('visibility', { state: document.visibilityState }));
  document.addEventListener('freeze', () => logPlayback('freeze'));
  document.addEventListener('resume', () => logPlayback('resume'));
  window.addEventListener('pagehide', (e) => logPlayback('pagehide', { persisted: e.persisted }));
  window.addEventListener('pageshow', (e) => logPlayback('pageshow', { persisted: e.persisted }));
  window.addEventListener('blur', () => logPlayback('blur'));
  window.addEventListener('focus', () => logPlayback('focus'));
  window.addEventListener('offline', () => logPlayback('offline'));
  window.addEventListener('online', () => logPlayback('online'));
}

// Tests only.
export function resetPlaybackLogForTests(): void {
  buffer = null;
  pageListeners = false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
