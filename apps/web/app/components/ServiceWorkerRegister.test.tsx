import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './ServiceWorkerRegister';

function fakes(readyState: DocumentReadyState = 'complete') {
  const register = vi.fn().mockResolvedValue({});
  const nav = { serviceWorker: { register } } as unknown as Navigator;
  const addEventListener = vi.fn();
  const win = { document: { readyState }, addEventListener } as unknown as Window;
  return { register, nav, win, addEventListener };
}

describe('registerServiceWorker', () => {
  it('does nothing outside production', () => {
    const { register, nav, win } = fakes();
    registerServiceWorker('development', nav, win);
    registerServiceWorker('test', nav, win);
    expect(register).not.toHaveBeenCalled();
  });

  it('registers /sw.js at scope / in production once the page has loaded', () => {
    const { register, nav, win } = fakes('complete');
    registerServiceWorker('production', nav, win);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('waits for the load event while the page is still loading', () => {
    const { register, nav, win, addEventListener } = fakes('loading');
    registerServiceWorker('production', nav, win);
    expect(register).not.toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith('load', expect.any(Function), { once: true });
    addEventListener.mock.calls[0][1]();
    expect(register).toHaveBeenCalledOnce();
  });

  it('is a no-op without service worker support', () => {
    const { win } = fakes();
    expect(() => registerServiceWorker('production', {} as Navigator, win)).not.toThrow();
  });
});
