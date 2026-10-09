'use client';

import { useEffect } from 'react';
import { PalcoErrorView } from '@/app/components/PalcoErrorView';
import { LogoMark } from '@/app/components/Logo';
import { PALCO_TOKENS } from '@/app/components/palcoCss';
import { trackError } from '@/lib/telemetry';

// Replaces the layout entirely, so it renders its own <html>/<body> and cannot
// rely on globals.css or the font variables. The palco page CSS ships inline with
// the scene (palcoCss.ts); fonts fall back to system-ui. Home is a plain <a> on
// purpose: a full reload is what a failed root needs.
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
    <html lang="pt-BR">
      <body style={{ margin: 0, background: PALCO_TOKENS.ink }}>
        <PalcoErrorView
          brand={
            // eslint-disable-next-line @next/next/no-html-link-for-pages -- root layout failed: reload, do not client-navigate
            <a href="/" className="pw-brand" aria-label="CoJam, início">
              <LogoMark size={36} />
              <span className="pw-brand__word">CoJam</span>
            </a>
          }
          home={
            // eslint-disable-next-line @next/next/no-html-link-for-pages -- see above
            <a href="/" className="pw-btn pw-btn--quiet">
              Voltar ao início
            </a>
          }
          reset={reset}
        />
      </body>
    </html>
  );
}
