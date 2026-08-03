import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RoomClient } from './client';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

// next/link outside an app-router render tree; a plain anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// jsdom has no matchMedia; LogoMark (room header, shown after joining)
// subscribes to it for reduced motion.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

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

// Stub the account layer: no real Supabase client is created in tests, and the
// session is controlled per case.
const accountMocks = vi.hoisted(() => ({
  session: null as { userId: string; email: string | null; accessToken: string } | null,
}));

vi.mock('@/lib/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account')>()),
  getAccountSession: vi.fn(async () => accountMocks.session),
  getConnectedServices: vi.fn(async () => []),
  getDisplayName: vi.fn(async () => null),
  markServiceConnected: vi.fn(async () => {}),
}));

// The distinct messages joinRoom rejects with per failure path (lib/realtime.ts);
// the join form must render each one in the alert, not collapse them.
const FAILURE_STATES: Array<[string, string]> = [
  ['server unreachable', 'Could not reach the server. Check your connection and try again.'],
  ['auth/token failure', 'Could not get a session token from the server (auth service issue). Try again in a moment.'],
  ['join timeout', 'Joining timed out. The server is taking too long to respond. Try again.'],
  ['unauthorized rejection', 'The server rejected the session as unauthorized. Try joining again.'],
];

// Verbatim copy from docs/specs/167-guest-identity-signal.md §2; a reword must
// not land silently.
const GUEST_COPY =
  'Your identity is stored in this browser. Sign in before leaving this room to keep your room role across devices.';

const withNormalizedWhitespace = (text: string) => (_: string, el?: Element | null) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() === text;

function enableAccounts() {
  window.__COJAM_ENV__ = { supabaseUrl: 'https://acct.supabase.co', supabaseAnonKey: 'anon-key' };
}

function seedRoomState(state: Partial<RoomState> & Pick<RoomState, 'queue'>) {
  useStore.setState({
    state: { roomId: 'NEON42', radioEnabled: false, version: 1, ...state },
  });
}

async function joinAs(name: string) {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Join & Play' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Join & Play' })).toBeNull();
  });
}

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

describe('RoomClient shared room-age clock (#206)', () => {
  beforeEach(() => {
    realtimeMocks.joinError = null;
    accountMocks.session = null;
    sessionStorage.clear();
    delete window.__COJAM_ENV__;
    useStore.setState({ state: null, signedIn: false, name: '' });
  });

  it('shows the shared room age from server-stamped createdAt', async () => {
    const track: TrackRef = {
      id: 't1',
      title: 'Song',
      artist: 'Artist',
      sources: { youtube: { videoId: 'abc123', confidence: 1 } },
      addedBy: 'Bob',
    };
    seedRoomState({ queue: [track], nowPlayingId: 't1', createdAt: Date.now() - 300_000 });

    render(<RoomClient roomId="NEON42" />);
    await joinAs('Alice');

    await waitFor(() => {
      expect(document.querySelector('.np-timer')?.textContent).toMatch(/^in room 5:0\d$/);
    });
  });

  it('stays silent for rooms created before timestamps existed', async () => {
    const track: TrackRef = {
      id: 't1',
      title: 'Song',
      artist: 'Artist',
      sources: { youtube: { videoId: 'abc123', confidence: 1 } },
      addedBy: 'Bob',
    };
    seedRoomState({ queue: [track], nowPlayingId: 't1' });

    render(<RoomClient roomId="NEON42" />);
    await joinAs('Alice');

    await waitFor(() => {
      expect(screen.getByText('added by Bob')).toBeInTheDocument();
    });
    expect(document.querySelector('.np-timer')).toBeNull();
  });
});

describe('RoomClient guest-identity signal (#167)', () => {
  beforeEach(() => {
    realtimeMocks.joinError = null;
    accountMocks.session = null;
    sessionStorage.clear();
    delete window.__COJAM_ENV__;
    useStore.setState({ state: null, signedIn: false, name: '' });
  });

  afterEach(() => {
    delete window.__COJAM_ENV__;
  });

  it('renders the browser-local identity line on the join form when accounts are enabled', async () => {
    enableAccounts();

    render(<RoomClient roomId="NEON42" />);

    expect(await screen.findByText(withNormalizedWhitespace(GUEST_COPY))).toBeInTheDocument();
  });

  it('does not render the line when accounts are disabled at deploy', () => {
    render(<RoomClient roomId="NEON42" />);

    expect(screen.queryByText(withNormalizedWhitespace(GUEST_COPY))).toBeNull();
  });

  it('hides the line once a session exists, without a remount', async () => {
    enableAccounts();
    accountMocks.session = { userId: 'u1', email: null, accessToken: 'tok' };

    render(<RoomClient roomId="NEON42" />);

    await waitFor(() => {
      expect(screen.queryByText(withNormalizedWhitespace(GUEST_COPY))).toBeNull();
    });
  });

  it('shows the Guest marker in the room header for guests only', async () => {
    enableAccounts();

    render(<RoomClient roomId="NEON42" />);
    await joinAs('Alice');

    expect(document.querySelector('.guest-chip')?.textContent).toBe('Guest');

    // Signing in mid-session flips current session state; the marker
    // disappears on the next render, no remount (#167 spec §4).
    act(() => {
      useStore.getState().setSignedIn(true);
    });
    expect(document.querySelector('.guest-chip')).toBeNull();
  });

  it('never shows the Guest marker to a signed-in member', async () => {
    enableAccounts();
    accountMocks.session = { userId: 'u1', email: null, accessToken: 'tok' };

    render(<RoomClient roomId="NEON42" />);
    await joinAs('Alice');

    await waitFor(() => {
      expect(screen.getByText(/you’re/)).toBeInTheDocument();
    });
    expect(document.querySelector('.guest-chip')).toBeNull();
  });
});
