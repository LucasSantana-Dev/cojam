import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shouldResumeInBackground, attachResumeListeners, advanceWithRetry } from './backgroundPlayback';

describe('shouldResumeInBackground', () => {
  const base = { hidden: true, transportState: 'playing', muted: false };
  it('resumes a player paused, cued or unstarted while hidden under a playing room', () => {
    for (const ytState of [2, 5, -1]) expect(shouldResumeInBackground({ ...base, ytState })).toBe(true);
  });
  it('leaves a visible page alone (the user may have paused it)', () => {
    expect(shouldResumeInBackground({ ...base, ytState: 2, hidden: false })).toBe(false);
  });
  it('leaves a paused or stopped room, the muted visual video, and playing/ended/buffering states alone', () => {
    expect(shouldResumeInBackground({ ...base, ytState: 2, transportState: 'paused' })).toBe(false);
    expect(shouldResumeInBackground({ ...base, ytState: 2, muted: true })).toBe(false);
    for (const ytState of [0, 1, 3]) expect(shouldResumeInBackground({ ...base, ytState })).toBe(false);
  });
});

describe('attachResumeListeners', () => {
  it('fires on shown, thaw, pageshow, focus and online; not on hidden; cleans up', () => {
    const cb = vi.fn();
    const off = attachResumeListeners(cb);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cb).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('resume'));
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    expect(cb).toHaveBeenCalledTimes(5);
    off();
    window.dispatchEvent(new Event('focus'));
    expect(cb).toHaveBeenCalledTimes(5);
  });
});

describe('advanceWithRetry', () => {
  const never = () => false;
  it('retries a transient failure and then succeeds, with no timer racing (short delay)', async () => {
    const advance = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(undefined);
    await advanceWithRetry(advance, () => 't1', 'r', 't1', never, 3, 1);
    expect(advance).toHaveBeenCalledTimes(2);
  });
  it('does not retry a permission denial', async () => {
    const advance = vi.fn().mockRejectedValue(new Error('denied'));
    await advanceWithRetry(advance, () => 't1', 'r', 't1', () => true, 3, 1);
    expect(advance).toHaveBeenCalledTimes(1);
  });
  it('stops when the room already moved to another track', async () => {
    const advance = vi.fn().mockRejectedValue(new Error('timeout'));
    await advanceWithRetry(advance, () => 't2', 'r', 't1', never, 3, 1);
    expect(advance).toHaveBeenCalledTimes(1);
  });
  it('gives up after the retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const advance = vi.fn().mockRejectedValue(new Error('down'));
    await advanceWithRetry(advance, () => 't1', 'r', 't1', never, 2, 1);
    expect(advance).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

// Guard: only visuals may react to visibility. Playback code (players, sync,
// transport) must never pause or gate on it; resume-on-return is the one use.
describe('playback path never pauses on visibility', () => {
  const root = join(__dirname, '..');
  const files = [
    'app/room/components/YouTubePlayer.tsx',
    'app/room/components/SpotifyPlayer.tsx',
    'lib/useDriftCorrection.ts',
    'lib/playbackSync.ts',
    'lib/useVisualSync.ts',
    'lib/realtime.ts',
  ];
  it.each(files)('%s has no visibility-driven pause', (f) => {
    const src = readFileSync(join(root, f), 'utf8');
    expect(src).not.toMatch(/visibilitychange/);
    expect(src).not.toMatch(/pagehide/);
    expect(src).not.toMatch(/document\.hidden[^;\n]*\bpause/);
  });
  it('sanity: the root exists', () => {
    expect(statSync(root).isDirectory()).toBe(true);
    expect(readdirSync(join(root, 'lib')).length).toBeGreaterThan(0);
  });
});
