'use client';

import { useState, useEffect } from 'react';
import { useStore } from '@/lib/realtime';

export function StatusBanner() {
  const connected = useStore((s) => s.connected);
  const reconnecting = useStore((s) => s.reconnecting);
  const [showBanner, setShowBanner] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (reconnecting) {
      setShowBanner(true);
      setIsExiting(false);
    } else if (connected && showBanner) {
      // Connection recovered; slide the banner out
      setIsExiting(true);
      const timer = setTimeout(() => {
        setShowBanner(false);
        setIsExiting(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [connected, reconnecting, showBanner]);

  if (!showBanner) return null;

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
      </div>
    </div>
  );
}
