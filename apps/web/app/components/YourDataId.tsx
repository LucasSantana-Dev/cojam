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

export function YourDataId({ inline = false }: { inline?: boolean } = {}) {
  const id = useSyncExternalStore(noopSubscribe, getStoredUserId, () => null);
  const [copied, setCopied] = useState(false);
  // False on the server and during hydration: the inline variant must not flash
  // "no code" before localStorage has been read.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  if (!id) {
    if (!mounted) return null;
    // Inline (the privacy page): say why there is nothing to copy instead of
    // leaving an empty section. Elsewhere the control stays hidden.
    return inline ? (
      <p>Este navegador ainda não guarda um código, porque você não entrou em nenhuma sala. Não há nada para excluir a partir daqui.</p>
    ) : null;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable or denied: the id is on screen and selectable.
    }
  };

  const body = (
    <>
      <p>Para pedir a exclusão dos seus dados, envie este código para o contato da política de privacidade.</p>
      <p className="your-data-row">
        <code>{id}</code>
        <button type="button" onClick={copy} aria-label={copied ? 'Código copiado' : 'Copiar código'}>
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </p>
    </>
  );
  if (inline) return <div className="your-data your-data--inline">{body}</div>;
  return (
    <details className="your-data">
      <summary>Seus dados</summary>
      {body}
    </details>
  );
}
