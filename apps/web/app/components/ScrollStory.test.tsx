import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const create = vi.fn();
const revert = vi.fn();
vi.mock('gsap', () => ({
  default: {
    registerPlugin: vi.fn(),
    context: (fn: () => void) => {
      fn();
      return { revert, add: (f: () => void) => f() };
    },
    fromTo: vi.fn(),
  },
}));
vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: { create } }));

import { ScrollStory } from './ScrollStory';

const mk = () => [
  { n: '01', t: 'a', d: 'a' },
  { n: '02', t: 'b', d: 'b' },
  { n: '03', t: 'c', d: 'c' },
];

describe('ScrollStory pin (regression: re-pinned on every parent render)', () => {
  it('creates the ScrollTrigger once and never reverts across re-renders with a fresh steps array', async () => {
    create.mockClear();
    revert.mockClear();
    const onActive = vi.fn();
    const { rerender, unmount } = render(<ScrollStory steps={mk()} onActive={onActive} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) rerender(<ScrollStory steps={mk()} onActive={onActive} waveAnimate={i % 2 === 0} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(create).toHaveBeenCalledTimes(1);
    expect(revert).not.toHaveBeenCalled();
    expect(onActive).not.toHaveBeenCalledWith(null);
    unmount();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(onActive).toHaveBeenCalledWith(null);
  });
});
