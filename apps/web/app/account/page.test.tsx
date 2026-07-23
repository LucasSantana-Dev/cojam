import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AccountPage from './page';

// Mock at the module boundaries: the page only reads supabaseEnabled() and the
// account-layer functions; the real Supabase client is never constructed.
const supabaseMock = vi.hoisted(() => ({
  supabaseEnabled: vi.fn(() => false),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseEnabled: supabaseMock.supabaseEnabled,
}));

vi.mock('@/lib/account', () => ({
  getAccountSession: vi.fn(async () => null),
  signInWithEmail: vi.fn(async () => ({ error: null })),
  signInWithGoogle: vi.fn(async () => ({ error: null })),
  signOut: vi.fn(async () => {}),
  getDisplayName: vi.fn(async () => null),
  saveDisplayName: vi.fn(async () => ({ error: null })),
  getConnectedServices: vi.fn(async () => []),
}));

// next/link outside an app-router render tree; a plain anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('AccountPage', () => {
  beforeEach(() => {
    supabaseMock.supabaseEnabled.mockReset();
  });

  it('shows the not-configured state when the accounts flag is off', async () => {
    supabaseMock.supabaseEnabled.mockReturnValue(false);

    render(<AccountPage />);

    expect(await screen.findByText('Accounts are not configured on this deployment.'))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back home' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('textbox', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('renders the signed-out sign-in form when the accounts flag is on', async () => {
    supabaseMock.supabaseEnabled.mockReturnValue(true);

    render(<AccountPage />);

    expect(await screen.findByRole('button', { name: 'Email me a sign-in link' }))
      .toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });
});
