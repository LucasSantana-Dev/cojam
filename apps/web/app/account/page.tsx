'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabaseEnabled } from '@/lib/supabase';
import {
  getAccountSession,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  getDisplayName,
  saveDisplayName,
  getConnectedServices,
  type AccountSession,
  type ConnectedProvider,
} from '@/lib/account';

const PROVIDER_LABEL: Record<ConnectedProvider, string> = {
  spotify: 'Spotify',
  apple: 'Apple Music',
};

export default function AccountPage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [services, setServices] = useState<ConnectedProvider[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // supabaseEnabled() reads runtime /env.js values that can differ from the
  // build-time NEXT_PUBLIC_* seen during SSR, so render a placeholder until
  // mount to keep SSR and the first client render in agreement.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    (async () => {
      const s = await getAccountSession();
      setSession(s);
      if (s) {
        const [name, svc] = await Promise.all([getDisplayName(), getConnectedServices()]);
        setDisplayName(name ?? '');
        setServices(svc);
      }
      setLoaded(true);
    })();
  }, []);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error: err } = await signInWithEmail(email.trim());
    setBusy(false);
    if (err) setError(err);
    else setMessage('Check your email for the sign-in link.');
  };

  const handleGoogle = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    const { error: err } = await signInWithGoogle();
    // On success the browser navigates away to Google; only errors land here.
    setBusy(false);
    if (err) setError(err);
  };

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error: err } = await saveDisplayName(displayName.trim());
    setBusy(false);
    if (err) setError(err);
    else setMessage('Display name saved.');
  };

  const handleSignOut = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await signOut();
      setSession(null);
      setServices([]);
      setDisplayName('');
    } catch {
      setError('Could not sign out. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!mounted || !loaded) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="panel p-6 max-w-md w-full space-y-2">
          <div className="skeleton-shimmer h-6 rounded" />
          <div className="skeleton-shimmer h-10 rounded" />
        </div>
      </main>
    );
  }

  if (!supabaseEnabled()) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="panel p-6 max-w-md w-full text-center space-y-3">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>Accounts</h1>
          <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            Accounts are not configured on this deployment.
          </p>
          <Link href="/" className="text-sm underline" style={{ color: 'var(--color-accent)' }}>Back home</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="panel p-6 max-w-md w-full space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>Account</h1>
          <Link href="/" className="text-sm underline" style={{ color: 'var(--color-accent)' }}>Home</Link>
        </div>

        {!session ? (
          <div className="space-y-3">
            <form onSubmit={handleSignIn} className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                Sign in to keep your name and connected services across devices. Guests can keep using rooms without an account.
              </p>
              <input
                type="email"
                required
                placeholder="you@example.com"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2.5 text-sm rounded-lg focus:outline-none border"
                style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
              />
              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="w-full px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
              >
                {busy ? 'Sending...' : 'Email me a sign-in link'}
              </button>
            </form>
            <div className="flex items-center gap-3" aria-hidden>
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--color-border)' }} />
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>or</span>
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--color-border)' }} />
            </div>
            <button
              type="button"
              onClick={handleGoogle}
              disabled={busy}
              className="w-full px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 border"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)', backgroundColor: 'var(--color-surface-2)' }}
            >
              Continue with Google
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Signed in as <span style={{ color: 'var(--color-text-primary)' }}>{session.email ?? session.userId}</span>
            </p>

            <form onSubmit={handleSaveName} className="space-y-2">
              <label className="block text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                Display name
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Your name in rooms"
                  aria-label="Display name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="flex-1 px-4 py-2 text-sm rounded-lg focus:outline-none border"
                  style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
                >
                  Save
                </button>
              </div>
            </form>

            <div className="space-y-1">
              <h2 className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>Connected services</h2>
              {services.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  None yet. Connect Spotify inside a room and it shows up here.
                </p>
              ) : (
                <ul className="space-y-1">
                  {services.map((p) => (
                    <li key={p} className="text-sm" style={{ color: 'var(--color-text-primary)' }}>
                      {PROVIDER_LABEL[p]}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              disabled={busy}
              className="w-full px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 border"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              Sign out
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--color-status-error)' }}>{error}</p>
        )}
        {message && (
          <p role="status" className="text-sm" style={{ color: '#86efac' }}>{message}</p>
        )}
      </div>
    </main>
  );
}
