'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { LogoMark } from '@/app/components/Logo';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';
import { trackError } from '@/lib/telemetry';

// Segment boundary; root-layout failures fall through to global-error.tsx.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[cojam] segment error', error);
    trackError('boundary_segment', error);
  }, [error]);

  return (
    <SintoniaScreen>
      <main id="main" className="sx-main">
        <div className="sx-glass sx-card sx-card--narrow sx-center">
          <div className="sx-brand">
            <LogoMark size={20} /> CoJam
          </div>
          <h1 className="sx-title sx-title--sm">Deu um problema do nosso lado</h1>
          <SineLine flat />
          <p className="sx-text">
            A sala provavelmente está bem. Tente de novo; se continuar, a fila
            está segura no servidor.
          </p>
          <div className="sx-actions sx-actions--center">
            <button type="button" onClick={reset} className="btn-primary">
              Tentar de novo
            </button>
            <Link href="/" className="btn-ghost">
              Voltar ao início
            </Link>
          </div>
          {error.digest && <p className="sx-ref">ref {error.digest}</p>}
        </div>
      </main>
    </SintoniaScreen>
  );
}
