'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  AdminError,
  describeValue,
  fetchFlags,
  loadToken,
  parseRooms,
  saveToken,
  updateFlag,
  type AdminFlag,
  type AdminFlagsState,
  type FlagValue,
} from '@/lib/adminFlags';

type Choice = 'env' | 'on' | 'off';

const CHOICES: { value: Choice; label: string }[] = [
  { value: 'env', label: 'Padrão' },
  { value: 'on', label: 'Ligado' },
  { value: 'off', label: 'Desligado' },
];

function choiceOf(enabled: boolean | null): Choice {
  return enabled === null ? 'env' : enabled ? 'on' : 'off';
}

function enabledOf(c: Choice): boolean | null {
  return c === 'env' ? null : c === 'on';
}

const ACTOR_LABEL: Record<string, string> = { panel: 'painel', cli: 'comando server flag' };

function sourceText(f: AdminFlag): string {
  switch (f.effective.source) {
    case 'override':
      return 'definido no painel';
    case 'env': {
      const v = f.serverEnv.value ? 'ligado' : 'desligado';
      return `pelo ambiente (${f.serverEnv.name} ${v})`;
    }
    default:
      return `padrão do código (${f.serverEnv.name} não definida)`;
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// One flag: a three-way choice (environment, on, off), the room list for
// screen share, a note, and Salvar. Nothing changes until Salvar.
function FlagRow({
  flag,
  writable,
  onSave,
}: {
  flag: AdminFlag;
  writable: boolean;
  onSave: (name: string, value: FlagValue & { note: string }) => Promise<string | null>;
}) {
  const current = flag.override;
  const [choice, setChoice] = useState<Choice>(choiceOf(current?.enabled ?? null));
  const hasRooms = flag.allowlistEnv !== undefined;
  const [roomsCustom, setRoomsCustom] = useState(current?.roomAllowlist != null);
  const [roomsText, setRoomsText] = useState((current?.roomAllowlist ?? []).join(', '));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const nextRooms = hasRooms && roomsCustom ? parseRooms(roomsText) : null;
  const curRooms = current?.roomAllowlist ?? null;
  const dirty =
    enabledOf(choice) !== (current?.enabled ?? null) ||
    JSON.stringify(nextRooms) !== JSON.stringify(curRooms);
  const turnsScreenOff =
    flag.name === 'screenShare' && flag.effective.enabled && (choice === 'off' || (choice === 'env' && !flag.serverEnv.value));

  const save = async () => {
    setBusy(true);
    setError('');
    const err = await onSave(flag.name, { enabled: enabledOf(choice), roomAllowlist: nextRooms, note: note.trim() });
    setBusy(false);
    if (err) setError(err);
    else setNote('');
  };

  const id = `flag-${flag.name}`;
  return (
    <li className="pw-plate pwad-flag" aria-labelledby={`${id}-title`}>
      <div className="pwad-flag__head">
        <h2 id={`${id}-title`} className="pwad-flag__title">
          {flag.label}
        </h2>
        <span className={flag.effective.enabled ? 'pwad-state pwad-state--on' : 'pwad-state'}>
          {flag.effective.enabled ? 'Ligado' : 'Desligado'}
        </span>
      </div>
      <p className="pw-text">{flag.help}</p>
      <p className="pwad-meta">
        Agora: {sourceText(flag)}. No web, sem valor no painel vale <code>{flag.webEnv}</code>.
        {hasRooms && (
          <>
            {' '}
            Salas:{' '}
            {flag.effective.roomAllowlist && flag.effective.roomAllowlist.length > 0
              ? flag.effective.roomAllowlist.join(', ')
              : 'todas as salas privadas elegíveis'}
            {flag.effective.roomAllowlistSource === 'override' ? ' (painel).' : ` (${flag.allowlistEnv?.name}).`}
          </>
        )}
      </p>
      {flag.blocked && (
        <p role="alert" className="pw-text pw-error">
          {flag.blocked}
        </p>
      )}

      <div className="pw-seg" role="group" aria-label={`${flag.label}: valor`}>
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={choice === c.value}
            disabled={!writable || busy}
            onClick={() => setChoice(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {hasRooms && (
        <div className="pwa-stack pwa-stack--tight">
          <label className="pwad-check">
            <input
              type="checkbox"
              checked={roomsCustom}
              disabled={!writable || busy}
              onChange={(e) => setRoomsCustom(e.target.checked)}
            />
            Limitar a salas escolhidas aqui (em vez de {flag.allowlistEnv?.name})
          </label>
          {roomsCustom && (
            <>
              <label htmlFor={`${id}-rooms`} className="pw-label">
                Códigos das salas (vazio = todas as salas privadas)
              </label>
              <textarea
                id={`${id}-rooms`}
                className="pw-input pwad-rooms"
                rows={2}
                placeholder="ABCDEF123456, ..."
                value={roomsText}
                disabled={!writable || busy}
                onChange={(e) => setRoomsText(e.target.value)}
              />
            </>
          )}
        </div>
      )}

      <div className="pwa-row">
        <input
          type="text"
          className="pw-input"
          aria-label={`${flag.label}: motivo da mudança`}
          placeholder="Motivo (opcional, fica no histórico)"
          maxLength={200}
          value={note}
          disabled={!writable || busy}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="button" className="pw-btn" disabled={!writable || busy || !dirty} onClick={save}>
          {busy ? 'Salvando...' : 'Salvar'}
        </button>
      </div>
      {dirty && turnsScreenOff && (
        <p className="pwad-meta">Salvar encerra os compartilhamentos de tela ao vivo.</p>
      )}
      {error && (
        <p role="alert" className="pw-text pw-error">
          {error}
        </p>
      )}
    </li>
  );
}

// The stored token is only readable in the browser: render nothing that
// depends on it until after hydration.
const noopSubscribe = () => () => {};

export function FlagsPanel() {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [token, setToken] = useState(loadToken);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<AdminFlagsState | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const fail = useCallback((e: unknown) => {
    const err = e instanceof AdminError ? e : new AdminError(0, 'Erro inesperado.');
    if (err.status === 401) {
      saveToken('');
      setToken('');
    }
    setState(null);
    setError(err.message);
  }, []);

  const load = useCallback(
    async (t: string) => {
      try {
        const next = await fetchFlags(t);
        setState(next);
        setError('');
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

  // The token present at mount (sessionStorage); signIn loads a new one itself.
  const [initialToken] = useState(token);
  useEffect(() => {
    if (!initialToken) return;
    (async () => {
      try {
        const next = await fetchFlags(initialToken);
        setState(next);
      } catch (e) {
        fail(e);
      }
    })();
  }, [initialToken, fail]);

  const loading = token !== '' && state === null && error === '';

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    saveToken(t);
    setToken(t);
    setDraft('');
    setError('');
    void load(t);
  };

  const signOut = () => {
    saveToken('');
    setToken('');
    setState(null);
    setMessage('');
  };

  const onSave = async (name: string, value: FlagValue & { note: string }): Promise<string | null> => {
    try {
      await updateFlag(token, name, value);
      setMessage('Mudança salva e aplicada no servidor.');
      await load(token);
      return null;
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) {
        signOut();
      }
      return e instanceof AdminError ? e.message : 'Erro inesperado.';
    }
  };

  if (!mounted) return null;

  if (!token || (!state && !loading)) {
    return (
      <div className="pw-plate pwa-card">
        <p className="pw-eyebrow">Admin</p>
        <h1 className="pw-title">Feature flags</h1>
        <form onSubmit={signIn} className="pwa-stack">
          <p className="pw-text">Entre com o token de admin do servidor (ADMIN_TOKEN). Ele fica só nesta aba.</p>
          <input
            type="password"
            autoComplete="current-password"
            aria-label="Token de admin"
            className="pw-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="pw-btn" disabled={!draft.trim()}>
            Entrar
          </button>
        </form>
        {error && (
          <p role="alert" className="pw-text pw-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (!state) {
    return (
      <div className="pw-plate pwa-card" aria-busy="true">
        <span className="pwa-skel pwa-skel--title" />
        <span className="pwa-skel" />
      </div>
    );
  }

  const labelOf = (name: string) => state.flags.find((f) => f.name === name)?.label ?? name;

  return (
    <div className="pwad">
      <div className="pw-plate pwad-intro">
        <div className="pwad-flag__head">
          <div>
            <p className="pw-eyebrow">Admin</p>
            <h1 className="pw-title">Feature flags</h1>
          </div>
          <button type="button" className="pw-btn pw-btn--quiet" onClick={signOut}>
            Sair
          </button>
        </div>
        <p className="pw-text">
          Padrão segue as variáveis de ambiente. Ligado ou Desligado vale para o servidor e para o web até você voltar
          para Padrão. O servidor aplica na hora; quem já está numa sala vê a mudança ao recarregar a página.
        </p>
        {!state.writable && (
          <p role="alert" className="pw-text pw-error">
            O servidor está sem banco (DATABASE_URL), então as flags só podem ser lidas.
          </p>
        )}
        {message && (
          <p role="status" className="pw-text">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="pw-text pw-error">
            {error}
          </p>
        )}
      </div>

      <ul className="pwad-list">
        {state.flags.map((f) => (
          // Keyed on the stored value so a save resets the row's draft.
          <FlagRow
            key={`${f.name}:${f.override?.updatedAt ?? 'env'}`}
            flag={f}
            writable={state.writable}
            onSave={onSave}
          />
        ))}
      </ul>

      <section className="pw-plate pwad-history" aria-labelledby="pwad-history-title">
        <h2 id="pwad-history-title" className="pwad-flag__title">
          Histórico
        </h2>
        {state.changes.length === 0 ? (
          <p className="pw-text">Nenhuma mudança ainda.</p>
        ) : (
          <ol className="pwad-changes">
            {state.changes.map((c) => (
              <li key={c.id}>
                <span className="pwad-meta">
                  {formatTime(c.createdAt)} · {ACTOR_LABEL[c.actor] ?? c.actor}
                </span>
                <span>
                  <strong>{labelOf(c.name)}</strong>: {describeValue(c.before)} → {describeValue(c.after)}
                </span>
                {c.note && <span className="pwad-meta">“{c.note}”</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
