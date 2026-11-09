'use client';

import { CheckIcon } from '@/app/components/icons';
import { useCopyText } from '@/lib/useCopyText';

// One-click invite: copies the current room URL so a friend can join. Clipboard
// needs a secure context (localhost / 127.0.0.1 / https all qualify).
export function ShareRoomButton() {
  const { copied, copy } = useCopyText();

  return (
    <button
      type="button"
      onClick={() => copy(window.location.href)}
      aria-label={copied ? 'Link de convite copiado' : 'Copiar link de convite'}
      className="r4-invite"
    >
      {copied && <CheckIcon size={16} />}
      {copied ? 'Copiado' : 'Convidar'}
    </button>
  );
}
