'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LogoMark } from '@/app/components/Logo';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';
import { handleCallback } from '@/lib/spotifyAuth';

type CallbackState = 'loading' | 'success' | 'error';

export default function SpotifyCallback() {
  const router = useRouter();
  const [state, setState] = useState<CallbackState>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authErr = params.get('error');

    if (authErr || !code) {
      // Deferred so no setState runs synchronously inside the effect body.
      Promise.resolve().then(() => {
        if (authErr) console.error('spotify_auth_error', authErr, params.get('error_description'));
        setError('Não deu para autenticar. Tente de novo.');
        setState('error');
      });
      return;
    }

    handleCallback(code, params.get('state'))
      .then((returnPath) => {
        setState('success');
        setTimeout(() => router.replace(returnPath), 800);
      })
      .catch((e) => {
        console.error('spotify_callback_error', e);
        setError('Não deu para autenticar. Tente de novo.');
        setState('error');
      });
  }, [router]);

  return (
    <SintoniaScreen>
      <main id="main" className="sx-main">
        <div className="sx-glass sx-card sx-card--narrow sx-center" aria-live="polite">
          <div className="sx-brand">
            <LogoMark size={20} /> CoJam
          </div>

          {state === 'loading' && (
            <>
              <div className="sx-spinner" aria-hidden="true" />
              <h1 className="sx-title sx-title--sm">Conectando o Spotify...</h1>
            </>
          )}

          {state === 'success' && (
            <>
              <div className="sx-badge" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h1 className="sx-title sx-title--sm">Spotify conectado</h1>
              <SineLine />
            </>
          )}

          {state === 'error' && (
            <>
              <div className="sx-badge sx-badge--error" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </div>
              <h1 className="sx-title sx-title--sm">{error || 'Não deu para autenticar'}</h1>
              <SineLine flat />
              <div className="sx-actions sx-actions--center">
                <Link href="/" className="btn-ghost">
                  Voltar ao início
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
    </SintoniaScreen>
  );
}
