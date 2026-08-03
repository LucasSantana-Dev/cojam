import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { StatusBanner } from './StatusBanner';
import { useStore } from '@/lib/realtime';

// Only the retry RPC is mocked; the component drives the real zustand store
// (seeded below) so the banner transitions reflect actual app state flow.
const realtimeMocks = vi.hoisted(() => ({
  retryConnection: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  retryConnection: realtimeMocks.retryConnection,
}));

// A terminal disconnect (#187): the client was reconnecting, then gave up
// (connected=false, reconnecting=false) and nothing recreates it.
const forceTerminalDisconnect = () => {
  act(() => useStore.setState({ connected: false, reconnecting: true }));
  act(() => useStore.setState({ connected: false, reconnecting: false }));
};

describe('StatusBanner', () => {
  beforeEach(() => {
    useStore.setState({ connected: false, reconnecting: false });
    realtimeMocks.retryConnection.mockClear();
  });

  it('shows nothing before any connection attempt', () => {
    const { container } = render(<StatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Retry and Reload after a terminal disconnect (#187)', () => {
    render(<StatusBanner />);
    forceTerminalDisconnect();

    expect(screen.getByText('Connection lost')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('does not offer the actions while still reconnecting', () => {
    render(<StatusBanner />);
    act(() => useStore.setState({ connected: false, reconnecting: true }));

    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('Retry re-runs the join to recover the connection (#187)', () => {
    render(<StatusBanner />);
    forceTerminalDisconnect();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(realtimeMocks.retryConnection).toHaveBeenCalledTimes(1);
  });
});
