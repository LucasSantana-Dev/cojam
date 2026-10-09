'use client';

import { useEffect, useRef, useState } from 'react';
import { fileReport, type ReportCategory, type ReportKind } from '@/lib/report';

// Report a room or a user (#259). Open to guests: it only needs a room id.
// Same native <dialog> pattern as the age gate, which gives modal focus
// handling for free. Copy is PT-BR because the directory audience is Brazilian.

export type ReportTarget = {
  roomId: string;
  kind: Extract<ReportKind, 'room' | 'member'>;
  // Member reports carry the member's client id and display name; room reports
  // omit both. The name is copied because presence is ephemeral too.
  subjectId?: string;
  subjectLabel?: string;
};

export const REPORT_CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: 'minor_at_risk', label: 'Uma criança ou adolescente pode estar em risco' },
  { value: 'sexual_content', label: 'Conteúdo sexual ou nome impróprio' },
  { value: 'harassment', label: 'Assédio, ofensas ou discurso de ódio' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Outro motivo' },
];

const REASON_MAX = 300;

type Status = 'idle' | 'sending' | 'sent' | 'error';

export function useReportDialog() {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [category, setCategory] = useState<ReportCategory>('other');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (target && !el.open) el.showModal();
    if (!target && el.open) el.close();
  }, [target]);

  const open = (next: ReportTarget) => {
    setCategory('other');
    setReason('');
    setStatus('idle');
    setTarget(next);
  };
  const close = () => setTarget(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || status === 'sending') return;
    setStatus('sending');
    const ok = await fileReport({
      roomId: target.roomId,
      kind: target.kind,
      subjectId: target.subjectId,
      content: target.subjectLabel,
      reason: reason.trim() || undefined,
      category,
    });
    setStatus(ok ? 'sent' : 'error');
  };

  const title = target?.kind === 'member' ? 'Denunciar usuário' : 'Denunciar sala';

  const dialog = (
    <dialog
      ref={dialogRef}
      className="age-gate"
      aria-labelledby="report-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={close}
    >
      <form className="age-gate__panel" onSubmit={submit}>
        <h2 id="report-dialog-title" className="age-gate__title">{title}</h2>
        {status === 'sent' ? (
          <>
            <p className="age-gate__body" role="status">
              Denúncia enviada. Obrigado por ajudar a manter o CoJam seguro.
            </p>
            <div className="age-gate__actions">
              <button type="button" className="age-gate__btn" onClick={close}>Fechar</button>
            </div>
          </>
        ) : (
          <>
            <p className="age-gate__body">
              {target?.kind === 'member' && target.subjectLabel
                ? `Você está denunciando ${target.subjectLabel}. `
                : ''}
              Você não precisa de conta. Em caso de perigo imediato, ligue 190. Para
              violência contra crianças e adolescentes, ligue 100.
            </p>
            <label className="age-gate__field">
              <span className="age-gate__label">Motivo</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ReportCategory)}
                disabled={status === 'sending'}
                className="age-gate__input"
              >
                {REPORT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </label>
            <label className="age-gate__field">
              <span className="age-gate__label">Detalhes (opcional)</span>
              <textarea
                value={reason}
                maxLength={REASON_MAX}
                rows={3}
                onChange={(e) => setReason(e.target.value)}
                disabled={status === 'sending'}
                className="age-gate__input"
              />
            </label>
            {status === 'error' && (
              <p role="alert" className="age-gate__body age-gate__error">
                Não foi possível enviar a denúncia. Tente de novo em instantes.
              </p>
            )}
            <div className="age-gate__actions">
              <button type="submit" className="age-gate__btn" disabled={status === 'sending'}>
                {status === 'sending' ? 'Enviando...' : 'Enviar denúncia'}
              </button>
              <button type="button" className="age-gate__btn age-gate__btn--quiet" onClick={close}>Cancelar</button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );

  return { open, dialog };
}
