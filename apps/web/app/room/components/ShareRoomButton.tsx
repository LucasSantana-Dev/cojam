'use client';

import { useState } from 'react';
import { CheckIcon } from '@/app/components/icons';

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
      aria-label={copied ? 'Link de convite copiado' : 'Copiar link de convite'}
      className="r4-invite"
    >
      {copied && <CheckIcon size={16} />}
      {copied ? 'Copiado' : 'Convidar'}
    </button>
  );
}
