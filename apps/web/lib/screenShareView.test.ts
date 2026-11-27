import { describe, it, expect, vi, afterEach } from 'vitest';
import { enterFullscreen, resetVolumeProbe, shortcutFor, volumeWritable } from './screenShareView';

afterEach(() => {
  resetVolumeProbe();
  vi.restoreAllMocks();
});

describe('enterFullscreen', () => {
  it('uses element fullscreen when the browser has it', () => {
    const section = document.createElement('section');
    const req = vi.fn(async () => {});
    Object.defineProperty(section, 'requestFullscreen', { value: req });
    expect(enterFullscreen(section, null)).toBe(true);
    expect(req).toHaveBeenCalled();
  });

  it('falls back to the video player on the iPhone', () => {
    const section = document.createElement('section');
    Object.defineProperty(section, 'requestFullscreen', { value: undefined });
    const video = document.createElement('video');
    const native = vi.fn();
    Object.defineProperty(video, 'webkitEnterFullscreen', { value: native });
    expect(enterFullscreen(section, video)).toBe(true);
    expect(native).toHaveBeenCalled();
  });

  it('reports false when there is no fullscreen at all', () => {
    const section = document.createElement('section');
    Object.defineProperty(section, 'requestFullscreen', { value: undefined });
    expect(enterFullscreen(section, document.createElement('video'))).toBe(false);
  });
});

describe('volumeWritable', () => {
  it('is true where volume sticks', () => {
    expect(volumeWritable()).toBe(true);
  });

  it('is false where volume is read only', () => {
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = real(tag);
      if (tag === 'video') Object.defineProperty(el, 'volume', { get: () => 1, set: () => {} });
      return el;
    });
    expect(volumeWritable()).toBe(false);
  });
});

describe('shortcutFor', () => {
  const key = (k: string, over: Partial<KeyboardEvent> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: document.body, ...over }) as KeyboardEvent;

  it('maps F and M', () => {
    expect(shortcutFor(key('f'))).toBe('fullscreen');
    expect(shortcutFor(key('F'))).toBe('fullscreen');
    expect(shortcutFor(key('m'))).toBe('sound');
    expect(shortcutFor(key('x'))).toBeNull();
  });

  it('ignores typing and modified keys', () => {
    expect(shortcutFor(key('f', { target: document.createElement('input') }))).toBeNull();
    expect(shortcutFor(key('m', { target: document.createElement('textarea') }))).toBeNull();
    expect(shortcutFor(key('f', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('m', { metaKey: true }))).toBeNull();
  });
});
