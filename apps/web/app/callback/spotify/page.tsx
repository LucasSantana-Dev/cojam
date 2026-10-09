'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PalcoNav } from '@/app/components/PalcoNav';
import { PalcoScene } from '@/app/components/PalcoScene';
import { PalcoBrandBar } from '@/app/components/PalcoShell';
import { ServiceBadge } from '@/app/components/ServiceBadge';
import type { LedSpec } from '@/lib/palcoLed';
import { handleCallback, retryAuth } from '@/lib/spotifyAuth';
import {
  canRetrySpotifyConnect,
  kindFromAuthorizeError,
  kindFromError,
  spotifyConnectMessage,
  type SpotifyConnectErrorKind,
} from '@/lib/spotifyConnectError';

type CallbackState = 'loading' | 'success' | 'error';

// What the stage screen says in each state. No error codes (DESIGN.md, Copy).
const SCREEN: Record<CallbackState, LedSpec> = {
  loading: { title: 'CONECTANDO', scale: 1, sub: 'SPOTIFY', subTone: 'white' },
  success: { title: 'CONECTADO', scale: 1, sub: 'SPOTIFY', subTone: 'white' },
  error: { title: 'ERRO', scale: 2, sub: 'SPOTIFY', subTone: 'white' },
};

// Static, decorative progress: the exchange has no real percentage to show.
function Progress({ done }: { done: boolean }) {
  return (
    <span className="pwc-bar" aria-hidden="true">
      <span style={{ width: done ? '100%' : '55%' }} />
    </span>
  );
}

export default function SpotifyCallback() {
  const router = useRouter();
  const [state, setState] = useState<CallbackState>('loading');
  const [kind, setKind] = useState<SpotifyConnectErrorKind>('unknown');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const authErr = params.get('error');

    if (authErr || !code) {
      // Deferred so no setState runs synchronously inside the effect body.
      Promise.resolve().then(() => {
        if (authErr) console.error('spotify_auth_error', authErr);
        setKind(kindFromAuthorizeError(authErr) ?? 'expired');
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
        console.error('spotify_callback_error', e instanceof Error ? e.message : 'unknown');
        setKind(kindFromError(e));
        setState('error');
      });
  }, [router]);

  return (
    <div className="pw pwc">
      <PalcoBrandBar>
        <PalcoNav />
      </PalcoBrandBar>
      <PalcoScene kind="callback" led={SCREEN[state]}>
        <main id="main" className="pw-dock pw-plate pwc-dock">
          <div
            className="pw-dock__copy pwc-copy"
            aria-live={state === 'error' ? undefined : 'polite'}
            data-testid="spotify-callback"
          >
            {state === 'loading' && (
              <>
                <p className="pw-eyebrow pwc-eyebrow">
                  <ServiceBadge source="spotify" size="sm" title="" /> Spotify
                </p>
                <h1 className="pw-title">Conectando o Spotify...</h1>
              </>
            )}

            {state === 'success' && (
              <>
                <p className="pw-eyebrow pwc-eyebrow">
                  <ServiceBadge source="spotify" size="sm" title="" /> Spotify
                </p>
                <h1 className="pw-title">Spotify conectado</h1>
              </>
            )}

            {state === 'error' && (
              <>
                <p className="pw-eyebrow pwc-eyebrow pwc-eyebrow--error">Spotify · erro</p>
                <h1 className="pw-title">Não deu para conectar o Spotify</h1>
                <p className="pw-text" role="alert" data-testid="spotify-callback-error">
                  {spotifyConnectMessage(kind)}
                </p>
              </>
            )}
          </div>

          {state !== 'error' && <Progress done={state === 'success'} />}

          {state === 'error' && (
            <div className="pw-actions">
              <Link href="/" className="pw-btn pw-btn--quiet">
                Voltar ao início
              </Link>
              {canRetrySpotifyConnect(kind) && (
                <button
                  type="button"
                  className="pw-btn"
                  data-testid="spotify-callback-retry"
                  onClick={() => {
                    retryAuth().catch(() => {
                      setKind('unknown');
                    });
                  }}
                >
                  Tentar de novo
                </button>
              )}
            </div>
          )}
        </main>
      </PalcoScene>
    </div>
  );
}
