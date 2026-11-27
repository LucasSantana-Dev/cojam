// Viewer helpers for the screen share panel (#310, spec 5.7). Kept apart
// from the panel so each browser quirk has its own test.

type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

// Fullscreen on the whole viewer (video plus the notice and controls) where
// the browser allows it. The iPhone has no element fullscreen, only the
// video's own player, so that is the fallback there.
export function enterFullscreen(section: HTMLElement | null, video: HTMLVideoElement | null): boolean {
  if (section && typeof section.requestFullscreen === 'function') {
    void section.requestFullscreen().catch(() => {});
    return true;
  }
  const v = video as WebkitVideo | null;
  if (v && typeof v.webkitEnterFullscreen === 'function') {
    try {
      v.webkitEnterFullscreen();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function toggleFullscreen(section: HTMLElement | null, video: HTMLVideoElement | null): void {
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    void document.exitFullscreen?.().catch(() => {});
    return;
  }
  enterFullscreen(section, video);
}

// iOS keeps media volume under the hardware buttons: writing volume does
// nothing and reading it back still says 1. Then the slider is dead weight.
let writable: boolean | null = null;
export function volumeWritable(): boolean {
  if (writable !== null) return writable;
  if (typeof document === 'undefined') return true;
  try {
    const probe = document.createElement('video');
    probe.volume = 0.5;
    writable = Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    writable = false;
  }
  return writable;
}

// For tests: forget the probe result.
export function resetVolumeProbe(): void {
  writable = null;
}

export type ShareShortcut = 'fullscreen' | 'sound';

// F toggles fullscreen and M toggles sound while watching. Typing in a
// field (the chat, the quality select) and modified keys never trigger.
export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>): ShareShortcut | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ''))) return null;
  const k = e.key.toLowerCase();
  if (k === 'f') return 'fullscreen';
  if (k === 'm') return 'sound';
  return null;
}
