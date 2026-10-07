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
    expect(await screen.findByText(/12 people in 4 rooms right now/)).toBeInTheDocument();
  });

  it('uses singular forms', async () => {
    respond({ people: 1, rooms: 1 });
    render(<LiveCounter />);
    expect(await screen.findByText(/1 person in 1 room right now/)).toBeInTheDocument();
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
});
