'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { PalcoNav, useCreateRoom } from '@/app/components/PalcoNav';
import { PalcoScene } from '@/app/components/PalcoScene';
import { PalcoBrandBar, PalcoFooter } from '@/app/components/PalcoShell';
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
};

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};

// Palco screen (wave 2): the band scene reads "CONTA / SUA ENTRADA", the account sits on one plate.
function AccountShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pw pwa">
      <PalcoBrandBar>
        <PalcoNav create />
      </PalcoBrandBar>
      <PalcoScene kind="band" led={{ title: 'CONTA', scale: 2, sub: 'SUA ENTRADA' }} />
      <main id="main" className="pwa-main">
        {children}
      </main>
      <PalcoFooter />
    </div>
  );
}

export default function AccountPage() {
  const createRoom = useCreateRoom();
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
      <AccountShell>
        <div className="pw-plate pwa-card" aria-busy="true">
          <span className="pwa-skel pwa-skel--title" />
          <span className="pwa-skel" />
        </div>
      </AccountShell>
    );
  }

  if (!supabaseEnabled()) {
    return (
      <AccountShell>
        <div className="pw-plate pwa-card">
          <p className="pw-eyebrow">Contas</p>
          <h1 className="pw-title">Ainda não tem conta por aqui</h1>
          <div className="pwa-stack pwa-stack--tight">
            <p className="pw-text">As contas não estão configuradas neste servidor.</p>
            <p className="pw-text">Você entra nas salas como convidado, só com o nome.</p>
          </div>
          <div className="pwa-actions">
            <button type="button" className="pw-btn" onClick={createRoom}>Criar sala</button>
            <Link href="/" className="pw-btn pw-btn--quiet">Voltar ao início</Link>
          </div>
        </div>
      </AccountShell>
    );
  }

  return (
    <AccountShell>
      <div className="pw-plate pwa-card">
        <p className="pw-eyebrow">Conta</p>
        <h1 className="pw-title">Sua conta</h1>

        {!session ? (
          <div className="pwa-stack">
            <form onSubmit={handleSignIn} className="pwa-stack">
              <p className="pw-text">
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
                className="pw-input"
              />
              <button type="submit" disabled={busy || !email.trim()} className="pw-btn">
                {busy ? 'Enviando...' : 'Receber link de acesso por e-mail'}
              </button>
            </form>
            <div className="pwa-or" aria-hidden>
              <span>ou</span>
            </div>
            <button type="button" onClick={handleGoogle} disabled={busy} className="pw-btn pw-btn--quiet">
              Continuar com o Google
            </button>
          </div>
        ) : (
          <div className="pwa-stack">
            <p className="pw-text">
              Conectado como <strong>{session.email ?? session.userId}</strong>
            </p>

            <form onSubmit={handleSaveName} className="pwa-stack pwa-stack--tight">
              <label htmlFor="account-display-name" className="pw-label">
                Nome de exibição
              </label>
              <div className="pwa-row">
                <input
                  id="account-display-name"
                  type="text"
                  placeholder="Seu nome nas salas"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="pw-input"
                />
                <button type="submit" disabled={busy} className="pw-btn">
                  Salvar
                </button>
              </div>
            </form>

            <div className="pwa-stack pwa-stack--tight">
              <h2 className="pw-label">Serviços conectados</h2>
              {services.length === 0 ? (
                <p className="pw-text">
                  Nenhum ainda. Conecte o Spotify dentro de uma sala e ele aparece aqui.
                </p>
              ) : (
                <ul className="pwa-list">
                  {services.map((p) => (
                    <li key={p}>{PROVIDER_LABEL[p]}</li>
                  ))}
                </ul>
              )}
            </div>

            <button type="button" onClick={handleSignOut} disabled={busy} className="pw-btn pw-btn--quiet">
              Sair
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="pw-text pw-error">{error}</p>
        )}
        {message && (
          <p role="status" className="pw-text">{message}</p>
        )}
      </div>
    </AccountShell>
  );
}
