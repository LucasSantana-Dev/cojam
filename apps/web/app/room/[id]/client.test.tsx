import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoomClient } from './client';

// next/link outside an app-router render tree; a plain anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Keep the real store (and its exports) but stub the network join so each
// failure path can reject with its distinct message.
const realtimeMocks = vi.hoisted(() => ({
  joinError: null as Error | null,
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  joinRoom: vi.fn(async () => {
    if (realtimeMocks.joinError) throw realtimeMocks.joinError;
    return {};
  }),
}));

// The distinct messages joinRoom rejects with per failure path (lib/realtime.ts);
// the join form must render each one in the alert, not collapse them.
const FAILURE_STATES: Array<[string, string]> = [
  ['server unreachable', 'Could not reach the server. Check your connection and try again.'],
  ['auth/token failure', 'Could not get a session token from the server (auth service issue). Try again in a moment.'],
  ['join timeout', 'Joining timed out. The server is taking too long to respond. Try again.'],
  ['unauthorized rejection', 'The server rejected the session as unauthorized. Try joining again.'],
];

describe('RoomClient join failure states (#190)', () => {
  beforeEach(() => {
    realtimeMocks.joinError = null;
    sessionStorage.clear();
  });

  it.each(FAILURE_STATES)('renders the distinct %s state in the alert', async (_label, message) => {
    realtimeMocks.joinError = new Error(message);

    render(<RoomClient roomId="NEON42" />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join & Play' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(message);
    });
  });
});
