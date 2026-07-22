import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mergeProviderPrefs } from './account';
import { __resetSupabaseForTests } from './supabase';

// Stub the Supabase client at the module boundary: getSupabase() is the only
// consumer, and it memoizes, so tests reset it via __resetSupabaseForTests.
const supabaseMock = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithOtp: supabaseMock.signInWithOtp,
      signInWithOAuth: supabaseMock.signInWithOAuth,
    },
  })),
}));

describe('mergeProviderPrefs', () => {
  it('returns empty when nothing is connected anywhere', () => {
    expect(mergeProviderPrefs([], {})).toEqual([]);
  });

  it('uses live state alone for guests (no persisted services)', () => {
    expect(mergeProviderPrefs([], { spotify: true })).toEqual(['spotify']);
  });

  it('uses persisted services alone when live state has not settled', () => {
    expect(mergeProviderPrefs(['spotify'], {})).toEqual(['spotify']);
  });

  it('unions both sources without duplicates, canonical order', () => {
    expect(mergeProviderPrefs(['apple'], { spotify: true })).toEqual(['spotify', 'apple']);
    expect(mergeProviderPrefs(['spotify'], { spotify: true })).toEqual(['spotify']);
  });

  it('ignores unknown persisted providers', () => {
    expect(mergeProviderPrefs(['tidal', 'spotify'], {})).toEqual(['spotify']);
  });
});

describe('signInWithGoogle', () => {
  it('errors cleanly when accounts are not configured', async () => {
    const { signInWithGoogle } = await import('./account');
    const { error } = await signInWithGoogle();
    expect(error).toBe('Accounts are not configured');
  });
});

describe('signInWithEmail', () => {
  beforeEach(() => {
    __resetSupabaseForTests();
    supabaseMock.signInWithOtp.mockReset();
    window.__COJAM_ENV__ = {
      supabaseUrl: 'https://acct.supabase.co',
      supabaseAnonKey: 'anon-key',
    };
  });

  afterEach(() => {
    delete window.__COJAM_ENV__;
    __resetSupabaseForTests();
  });

  it('sends a magic link pointing back at /account on success', async () => {
    supabaseMock.signInWithOtp.mockResolvedValue({ error: null });
    const { signInWithEmail } = await import('./account');

    const { error } = await signInWithEmail('dj@example.com');

    expect(error).toBeNull();
    expect(supabaseMock.signInWithOtp).toHaveBeenCalledWith({
      email: 'dj@example.com',
      options: { emailRedirectTo: `${window.location.origin}/account` },
    });
  });

  it('surfaces the Supabase error message on failure', async () => {
    supabaseMock.signInWithOtp.mockResolvedValue({ error: { message: 'Signups not allowed for otp' } });
    const { signInWithEmail } = await import('./account');

    const { error } = await signInWithEmail('dj@example.com');

    expect(error).toBe('Signups not allowed for otp');
  });

  it('errors cleanly when accounts are not configured', async () => {
    delete window.__COJAM_ENV__;
    const { signInWithEmail } = await import('./account');

    const { error } = await signInWithEmail('dj@example.com');

    expect(error).toBe('Accounts are not configured');
    expect(supabaseMock.signInWithOtp).not.toHaveBeenCalled();
  });
});
