'use client';

import { useState } from 'react';
import { LinkIcon, CheckIcon } from '@/app/components/icons';

// One-click invite: copies the current room URL so a friend can join. Clipboard
// needs a secure context (localhost / 127.0.0.1 / https all qualify).
export function ShareRoomButton() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const url = window.location.href;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Clipboard API unavailable (insecure context / denied). Fall back to a
      // hidden-textarea execCommand copy. No blocking dialog either way.
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <button
      onClick={copy}
      aria-label={copied ? 'Invite link copied' : 'Copy invite link'}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 hover:brightness-110 active:scale-95 focus:outline-none"
      style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
    >
      {copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />}
      {copied ? 'Copied' : 'Invite'}
    </button>
  );
}
