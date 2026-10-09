import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useVisualViewportHeight } from './useVisualViewportHeight';

function fakeViewport(height: number) {
  const target = new EventTarget();
  const vv = Object.assign(target, { height });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

describe('useVisualViewportHeight', () => {
  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    document.documentElement.style.removeProperty('--app-h');
  });

  it('publishes the visual viewport height and follows the keyboard', () => {
    const vv = fakeViewport(844);
    const { unmount } = renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('844px');
    vv.height = 460;
    vv.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('460px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('');
  });

  it('does nothing without a visual viewport', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    renderHook(() => useVisualViewportHeight());
    expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('');
  });
});
