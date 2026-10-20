import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveCounter } from './LiveCounter';

const respond = (body: unknown, ok = true) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })));

afterEach(() => vi.unstubAllGlobals());

describe('LiveCounter', () => {
  it('renders people and rooms', async () => {
    respond({ people: 12, rooms: 4 });
    render(<LiveCounter />);
    expect(await screen.findByText(/12 pessoas em 4 salas agora/)).toBeInTheDocument();
  });

  it('uses singular forms', async () => {
    respond({ people: 1, rooms: 1 });
    render(<LiveCounter />);
    expect(await screen.findByText(/1 pessoa em 1 sala agora/)).toBeInTheDocument();
  });

  it('is hidden when nobody is in a room', async () => {
    respond({ people: 0, rooms: 0 });
    const { container } = render(<LiveCounter />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden when the request fails', async () => {
    respond({}, false);
    const { container } = render(<LiveCounter />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('does not replace the DOM node when the poll returns the same count', async () => {
    vi.useFakeTimers();
    try {
      respond({ people: 5, rooms: 2 });
      render(<LiveCounter />);
      const node = await vi.waitFor(() => screen.getByText(/5 pessoas em 2 salas agora/));

      // Advance past the 30s poll interval; server still returns the same stats.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

      // Same DOM node reference: no remount → role="status" will not re-announce.
      expect(screen.getByText(/5 pessoas em 2 salas agora/)).toBe(node);
    } finally {
      vi.useRealTimers();
    }
  });
});
