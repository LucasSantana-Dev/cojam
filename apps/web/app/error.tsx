'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { PalcoBrand } from '@/app/components/PalcoShell';
import { PalcoErrorView } from '@/app/components/PalcoErrorView';
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
    <PalcoErrorView
      brand={<PalcoBrand />}
      home={
        <Link href="/" className="pw-btn pw-btn--quiet">
          Voltar ao início
        </Link>
      }
      reset={reset}
    />
  );
}
