'use client';

import { useEffect } from 'react';
import Link from 'next/link';
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
    <main id="main" className="min-h-dvh grid place-items-center p-6">
      <div className="panel max-w-md w-full p-6 text-center">
        <h1 className="text-xl font-semibold mb-2">That broke on our side</h1>
        <p className="text-sm opacity-70 mb-5">
          The room is probably fine. Try again, and if it keeps happening the
          queue is safe on the server.
        </p>
        <div className="flex gap-3 justify-center">
          <button type="button" onClick={reset} className="btn-primary">
            Try again
          </button>
          <Link href="/" className="btn-ghost">
            Back home
          </Link>
        </div>
        {error.digest && (
          <p className="mt-5 text-xs opacity-40 font-mono">ref {error.digest}</p>
        )}
      </div>
    </main>
  );
}
