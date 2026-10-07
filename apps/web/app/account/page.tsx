'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { LogoMark } from '@/app/components/Logo';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';
import { supabaseEnabled } from '@/lib/supabase';
import {
  getAccountSession,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  getDisplayName,
  saveDisplayName,
  getConnectedServices,
  type AccountSession,
  type ConnectedProvider,
} from '@/lib/account';

const PROVIDER_LABEL: Record<ConnectedProvider, string> = {
  spotify: 'Spotify',
  apple: 'Apple Music',
};

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};

export default function AccountPage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [services, setServices] = useState<ConnectedProvider[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // supabaseEnabled() reads runtime /env.js values that can differ from the
  // build-time NEXT_PUBLIC_* seen during SSR, so a server snapshot keeps SSR
  // and the first client render in agreement.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  useEffect(() => {
    (async () => {
      const s = await getAccountSession();
      setSession(s);
      if (s) {
        const [name, svc] = await Promise.all([getDisplayName(), getConnectedServices()]);
        setDisplayName(name ?? '');
        setServices(svc);
      }
      setLoaded(true);
    })();
  }, []);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error: err } = await signInWithEmail(email.trim());
    setBusy(false);
    if (err) setError(err);
    else setMessage('Confira seu e-mail: enviamos o link de acesso.');
  };

  const handleGoogle = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    const { error: err } = await signInWithGoogle();
    // On success the browser navigates away to Google; only errors land here.
    setBusy(false);
    if (err) setError(err);
  };

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const { error: err } = await saveDisplayName(displayName.trim());
    setBusy(false);
    if (err) setError(err);
    else setMessage('Nome salvo.');
  };

  const handleSignOut = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await signOut();
      setSession(null);
      setServices([]);
      setDisplayName('');
    } catch {
      setError('Não deu para sair. Tente de novo.');
    } finally {
      setBusy(false);
    }
  };

  if (!mounted || !loaded) {
    return (
      <SintoniaScreen>
        <main id="main" className="sx-main">
          <div className="sx-glass sx-card" aria-busy="true">
            <div className="skeleton-shimmer h-6 rounded" />
            <div className="skeleton-shimmer h-10 rounded" />
          </div>
        </main>
      </SintoniaScreen>
    );
  }

  if (!supabaseEnabled()) {
    return (
      <SintoniaScreen>
        <main id="main" className="sx-main">
          <div className="sx-glass sx-card">
            <div className="sx-brand">
              <LogoMark size={20} /> CoJam
            </div>
            <h1 className="sx-title">Contas</h1>
            <SineLine flat />
            <p className="sx-text">As contas não estão configuradas neste servidor.</p>
            <div className="sx-actions">
              <Link href="/" className="btn-ghost">Voltar ao início</Link>
            </div>
          </div>
        </main>
      </SintoniaScreen>
    );
  }

  return (
    <SintoniaScreen>
      <main id="main" className="sx-main">
        <div className="sx-glass sx-card">
          <div className="sx-bar">
            <div className="sx-brand">
              <LogoMark size={20} /> CoJam
            </div>
            <Link href="/" className="sx-link">Início</Link>
          </div>
          <h1 className="sx-title">Sua conta</h1>
          <SineLine flat={!session} />

          {!session ? (
            <div className="sx-stack">
              <form onSubmit={handleSignIn} className="sx-stack">
                <p className="sx-text">
                  Entre para guardar seu nome e seus serviços conectados em todos os dispositivos. Quem entra como convidado continua usando as salas sem conta.
                </p>
                <input
                  type="email"
                  required
                  placeholder="voce@exemplo.com"
                  aria-label="E-mail"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="join-input focus-ring-grow"
                />
                <button type="submit" disabled={busy || !email.trim()} className="btn-primary sx-block">
                  {busy ? 'Enviando...' : 'Receber link de acesso por e-mail'}
                </button>
              </form>
              <div className="sx-or" aria-hidden>
                <span>ou</span>
              </div>
              <button type="button" onClick={handleGoogle} disabled={busy} className="btn-ghost sx-block">
                Continuar com o Google
              </button>
            </div>
          ) : (
            <div className="sx-stack">
              <p className="sx-text">
                Conectado como <strong>{session.email ?? session.userId}</strong>
              </p>

              <form onSubmit={handleSaveName} className="sx-stack sx-stack--tight">
                <label htmlFor="account-display-name" className="sx-label">
                  Nome de exibição
                </label>
                <div className="sx-row">
                  <input
                    id="account-display-name"
                    type="text"
                    placeholder="Seu nome nas salas"
                    aria-label="Nome de exibição"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="join-input focus-ring-grow"
                  />
                  <button type="submit" disabled={busy} className="btn-primary">
                    Salvar
                  </button>
                </div>
              </form>

              <div className="sx-stack sx-stack--tight">
                <h2 className="sx-label">Serviços conectados</h2>
                {services.length === 0 ? (
                  <p className="sx-text sx-text--muted">
                    Nenhum ainda. Conecte o Spotify dentro de uma sala e ele aparece aqui.
                  </p>
                ) : (
                  <ul className="sx-list">
                    {services.map((p) => (
                      <li key={p}>{PROVIDER_LABEL[p]}</li>
                    ))}
                  </ul>
                )}
              </div>

              <button type="button" onClick={handleSignOut} disabled={busy} className="btn-ghost sx-block">
                Sair
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="sx-feedback sx-feedback--error">{error}</p>
          )}
          {message && (
            <p role="status" className="sx-feedback">{message}</p>
          )}
        </div>
      </main>
    </SintoniaScreen>
  );
}
