'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { handleCallback } from '@/lib/spotifyAuth';

type CallbackState = 'loading' | 'success' | 'error';

export default function SpotifyCallback() {
  const router = useRouter();
  const [state, setState] = useState<CallbackState>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authErr = params.get('error');

    if (authErr || !code) {
      // Deferred so no setState runs synchronously inside the effect body.
      Promise.resolve().then(() => {
        if (authErr) console.error('spotify_auth_error', authErr, params.get('error_description'));
        setError('Authentication failed. Try again.');
        setState('error');
      });
      return;
    }

    handleCallback(code)
      .then((returnPath) => {
        setState('success');
        setTimeout(() => router.replace(returnPath), 800);
      })
      .catch((e) => {
        console.error('spotify_callback_error', e);
        setError('Authentication failed. Try again.');
        setState('error');
      });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-surface-0)] text-sm">
      {/* Spinner state (loading) */}
      <div
        className="absolute"
        style={{
          opacity: state === 'loading' ? 1 : 0,
          transform: state === 'loading' ? 'scale(1)' : 'scale(0.95)',
          transition: 'opacity 0.3s ease, transform 0.3s ease',
          pointerEvents: state === 'loading' ? 'auto' : 'none',
        }}
      >
        <div
          className="w-12 h-12 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full"
          style={{ animation: 'callback-spin 1s linear infinite' }}
        />
        <p style={{ color: 'var(--color-text-secondary)', marginTop: '1rem' }}>
          Connecting Spotify...
        </p>
      </div>

      {/* Success state */}
      <div
        className="absolute text-center"
        style={{
          opacity: state === 'success' ? 1 : 0,
          transform: state === 'success' ? 'scale(1) translateY(0)' : 'scale(0.9) translateY(8px)',
          transition: 'opacity 0.4s ease, transform 0.4s ease',
          pointerEvents: state === 'success' ? 'auto' : 'none',
        }}
      >
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
          style={{
            background: 'color-mix(in oklab, var(--color-accent) 15%, transparent)',
            border: '2px solid var(--color-accent)',
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <p style={{ color: 'var(--color-text-primary)', marginTop: '1rem', fontWeight: 500 }}>
          Authentication successful
        </p>
      </div>

      {/* Error state */}
      <div
        className="absolute text-center max-w-sm px-4"
        style={{
          opacity: state === 'error' ? 1 : 0,
          transform: state === 'error' ? 'scale(1) translateY(0)' : 'scale(0.9) translateY(8px)',
          transition: 'opacity 0.4s ease, transform 0.4s ease',
          pointerEvents: state === 'error' ? 'auto' : 'none',
        }}
      >
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '2px solid #ef4444',
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </div>
        <p style={{ color: '#ef4444', marginTop: '1rem', fontWeight: 500 }}>
          {error || 'Authentication failed'}
        </p>
        <Link
          href="/"
          className="inline-block mt-3 px-4 py-2 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)] hover:border-[var(--color-accent)]"
          style={{
            background: 'var(--color-surface-2)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
            textDecoration: 'none',
          }}
        >
          Back to home
        </Link>
      </div>

    </div>
  );
}
