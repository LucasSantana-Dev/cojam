'use client';

import { useState, useEffect } from 'react';
import { useStore, retryConnection } from '@/lib/realtime';

export function StatusBanner() {
  const connected = useStore((s) => s.connected);
  const reconnecting = useStore((s) => s.reconnecting);
  const [showBanner, setShowBanner] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  // Enter transition: adjust state during render when the store flags flip.
  if (reconnecting && (!showBanner || isExiting)) {
    setShowBanner(true);
    setIsExiting(false);
  } else if (!reconnecting && connected && showBanner && !isExiting) {
    // Connection recovered; slide the banner out
    setIsExiting(true);
  }

  // Exit transition: only the timer lives in an effect (its setStates run in
  // the timeout callback, preserving the 300ms slide-out animation).
  useEffect(() => {
    if (!isExiting) return;
    const timer = setTimeout(() => {
      setShowBanner(false);
      setIsExiting(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [isExiting]);

  if (!showBanner) return null;

  // Terminal disconnect (#187): reconnecting stopped without recovering, so
  // offer a way out. Guarded on !connected so the slide-out after recovery
  // (reconnecting=false, connected=true) never flashes the buttons.
  const lost = !reconnecting && !connected;

  // Retry re-runs the full join (reconnect + resync); on failure the banner
  // stays up so the user can try again or reload.
  const handleRetry = () => {
    retryConnection().catch(() => { /* banner stays up for another attempt */ });
  };

  return (
    <div
      className={`fixed top-0 left-0 right-0 px-4 py-3 text-center text-sm font-medium z-50 status-banner${isExiting ? ' slide-up-exit' : ''}`}
      style={{
        background: reconnecting
          ? `color-mix(in oklab, var(--color-status-warn) 15%, var(--color-surface-0))`
          : `color-mix(in oklab, var(--color-status-error) 15%, var(--color-surface-0))`,
        borderBottom: `1px solid ${reconnecting ? 'var(--color-status-warn)' : 'var(--color-status-error)'}`,
      }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-center gap-3">
        <div
          className="w-2 h-2 rounded-full"
          style={{
            backgroundColor: reconnecting ? 'var(--color-status-warn)' : 'var(--color-status-error)',
            animation: 'pulse-breath 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          }}
        />
        <span style={{ color: reconnecting ? 'var(--color-status-warn)' : 'var(--color-status-error)' }}>
          {reconnecting ? 'Reconnecting...' : 'Connection lost'}
        </span>
        {lost && (
          <>
            <button
              type="button"
              onClick={handleRetry}
              className="px-3 py-1 text-xs font-semibold rounded-md transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
              style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1 text-xs font-semibold rounded-md transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
              style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
            >
              Reload
            </button>
          </>
        )}
      </div>
    </div>
  );
}
