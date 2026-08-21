'use client';

import { useEffect } from 'react';
import { trackError } from '@/lib/telemetry';

// Replaces the layout entirely, so it renders its own <html>/<body> and cannot
// rely on globals.css being applied. Hence the inline styles.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[cojam] root error', error);
    trackError('boundary_root', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: '#020202',
          color: '#f5f5f5',
          fontFamily: 'system-ui, sans-serif',
          padding: '1.5rem',
        }}
      >
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
            CoJam failed to load
          </h1>
          <p style={{ fontSize: '0.875rem', opacity: 0.7, marginBottom: '1.25rem' }}>
            Something went wrong before the app started.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: '1px solid #333',
              background: '#141414',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ marginTop: '1.25rem', fontSize: '0.75rem', opacity: 0.4 }}>
              ref {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
