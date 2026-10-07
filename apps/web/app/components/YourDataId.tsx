'use client';

import { useState, useSyncExternalStore } from 'react';
import { getStoredUserId } from '@/lib/auth';

// Shows the guest id kept in this browser so a person can ask for their data
// to be erased (LGPD, #318). The id is the only link between a guest and what
// the server stores about them, and only this browser keeps a copy of it.
// Renders nothing until an id exists (a visitor who never joined a room has
// no data to erase). The server snapshot is null: localStorage does not exist
// on the server render, so SSR and hydration agree.
const noopSubscribe = () => () => {};

export function YourDataId() {
  const id = useSyncExternalStore(noopSubscribe, getStoredUserId, () => null);
  const [copied, setCopied] = useState(false);

  if (!id) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable or denied: the id is on screen and selectable.
    }
  };

  return (
    <details className="your-data">
      <summary>Seus dados</summary>
      <p>Para pedir a exclusão dos seus dados, envie este código para o contato da política de privacidade.</p>
      <p className="your-data-row">
        <code>{id}</code>
        <button type="button" onClick={copy} aria-label={copied ? 'Código copiado' : 'Copiar código'}>
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </p>
    </details>
  );
}
