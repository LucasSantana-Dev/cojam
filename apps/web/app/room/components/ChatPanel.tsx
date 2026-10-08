'use client';

import { useMotion } from '@/lib/motionFlags';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore, sendChat, deleteChatMessage, rpcErrorMessage, getClockOffsetMs } from '@/lib/realtime';
import { fileReport } from '@/lib/report';
import { formatRelativeTime } from '@/lib/relativeTime';
import { avatarGradient } from '@/lib/avatar';
import { EmojiIcon } from '@/app/components/icons';

// A short, fixed set: a full picker is out of scope, this covers a room's reactions.
const EMOJIS = ['😂', '😍', '🔥', '👏', '🎶', '❤️', '🙌', '😎', '🥹', '👍', '🤘', '💜'];

// Server caps chat text at 300 chars (F8); the input enforces the same limit
// so the client never ships a message the server would reject.
const MAX_CHAT_TEXT_LEN = 300;

// sentAtServerMs is server time; apply the measured offset (clockSync) before
// diffing so skewed client clocks do not show fake relative times.
function chatTime(sentAtServerMs: number): string {
  return formatRelativeTime(sentAtServerMs, Date.now() + getClockOffsetMs()) ?? '';
}

// Auto-scroll follows new messages only when the user is already within this
// distance of the bottom (#189); anyone reading scrollback keeps their spot.
const NEAR_BOTTOM_PX = 80;

interface ChatPanelProps {
  roomId: string;
  // Host moderation affordance (#181): the host sees a delete button per
  // message. The server re-checks host status; this prop is convenience only.
  canControl?: boolean;
}

export function ChatPanel({ roomId, canControl = false }: ChatPanelProps) {
  const chat = useStore((s) => s.chat);
  const connected = useStore((s) => s.connected);
  const name = useStore((s) => s.name);
  const hostUserId = useStore((s) => s.state?.hostUserId);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Recompute the pin on every scroll: near the bottom means follow new
  // messages; further up means the user is reading scrollback (#189).
  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  // Auto-scroll to the newest line on append only when pinned to the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  // Cor da faixa motion (#325): a new line springs in. Only live arrivals (one to
  // three at a time), never the history that lands on join. Off under
  // prefers-reduced-motion.
  const motion = useMotion();
  const seenCount = useRef<number | null>(null);
  useEffect(() => {
    const prev = seenCount.current;
    seenCount.current = chat.length;
    const list = listRef.current;
    if (!motion.flip || prev === null || prev === 0 || !list) return;
    const added = chat.length - prev;
    if (added < 1 || added > 3) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-testid="chat-message"]')).slice(-added);
    if (rows.length === 0) return;
    let cancelled = false;
    import('gsap').then(({ default: gsap }) => {
      if (cancelled) return;
      gsap.fromTo(rows, { y: 16, scale: 0.94, opacity: 0, transformOrigin: '0 100%' }, { y: 0, scale: 1, opacity: 1, duration: 0.55, ease: 'back.out(2.2)', stagger: 0.06, clearProps: 'transform,opacity' });
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chat.length, motion.flip]);

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected || sending) return;
    setActionError('');
    setSending(true);
    try {
      // Server-first: the message renders when the chat.message publication
      // round-trips, so a rejected send leaves nothing to roll back. Keep the
      // draft on failure so the user can retry without retyping.
      await sendChat(roomId, text, name);
      setDraft('');
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Não deu para enviar a mensagem. Tente de novo.'));
    } finally {
      setSending(false);
    }
  };

  // Host tombstone (#181): server-first like send — the line disappears when
  // the chat.delete publication round-trips, so a rejection needs no rollback.
  // deletingIds guards the window until the publication arrives: a second
  // click would send a duplicate delete and surface "message not found" for
  // an action that succeeded.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // Reported ids are kept locally so the control reads as done. The report is
  // durable server-side; this is only the affordance.
  const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());
  const handleReport = async (messageId: string, text: string, name: string) => {
    if (reportedIds.has(messageId)) return;
    setReportedIds((prev) => new Set(prev).add(messageId));
    const ok = await fileReport({
      roomId,
      kind: 'message',
      subjectId: messageId,
      content: text,
      reason: `reported message from ${name}`,
    });
    if (!ok) {
      setReportedIds((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  };
  const handleDelete = async (messageId: string) => {
    if (deletingIds.has(messageId)) return;
    setDeletingIds((prev) => new Set(prev).add(messageId));
    setActionError('');
    try {
      await deleteChatMessage(roomId, messageId);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Não deu para apagar a mensagem. Tente de novo.'));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  };

  return (
    <div className="panel chat-panel r4-card">
      <header className="r4-qhead">
        <h3 className="r4-h2">Chat da Sala</h3>
      </header>

      {actionError && (
        <p role="alert" aria-live="polite" className="text-sm" style={{ color: 'var(--color-status-error-soft)' }}>
          {actionError}
        </p>
      )}

      {chat.length === 0 ? (
        <div className="chat-empty">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Nenhuma mensagem ainda. Diga oi.
          </p>
          {!connected && (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Você está desconectado. Reconecte para enviar mensagens.
            </p>
          )}
        </div>
      ) : (
        <div ref={listRef} onScroll={handleScroll} className="chat-scroll" aria-live="polite">
          {chat.map((m) => (
            m.kind === 'system' ? (
              // Server announcements (#205): no avatar/identity, muted so track
              // changes and join/leave read as room events, not chat.
              <div key={m.id} data-testid="chat-system-message" className="chat-sys" title={chatTime(m.sentAtServerMs)}>
                <p className="chat-sys__text">{m.text}</p>
              </div>
            ) : (
            <div
              key={m.id}
              data-testid="chat-message"
              className={`chat-msg group${m.userId && m.userId === hostUserId ? ' chat-msg--host' : ''}`}
            >
              <span
                className="chat-msg__av avatar-chip"
                style={{ background: avatarGradient(m.userId || m.name) }}
                aria-hidden
              >
                {m.name.charAt(0).toUpperCase()}
              </span>
              <div className="chat-msg__body">
                <div className="chat-msg__who">
                  <span className="chat-msg__name">{m.name}</span>
                  {m.userId && m.userId === hostUserId && (
                    <span className="chat-host">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                        <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z" />
                      </svg>
                      anfitrião
                    </span>
                  )}
                  <span className="chat-msg__time" title="Enviada há">{chatTime(m.sentAtServerMs)}</span>
                </div>
                <p className="chat-msg__text">{m.text}</p>
              </div>
              <button
                type="button"
                onClick={() => handleReport(m.id, m.text, m.name)}
                disabled={reportedIds.has(m.id)}
                title={reportedIds.has(m.id) ? 'Denunciada' : 'Denunciar mensagem'}
                aria-label={reportedIds.has(m.id) ? `Mensagem de ${m.name} denunciada` : `Denunciar mensagem de ${m.name}`}
                className="chat-msg__act"
              >
                {reportedIds.has(m.id) ? '✓' : '⚑'}
              </button>
              {canControl && (
                <button
                  type="button"
                  onClick={() => handleDelete(m.id)}
                  disabled={deletingIds.has(m.id)}
                  title="Apagar mensagem (anfitrião)"
                  aria-label={`Apagar mensagem de ${m.name}`}
                  className="chat-msg__act"
                >
                  ×
                </button>
              )}
            </div>
            )
          ))}
        </div>
      )}

      <form onSubmit={handleSend} className="chat-form">
        <input
          ref={inputRef}
          type="text"
          placeholder={connected ? 'Conversar com a sala...' : 'Reconecte para enviar mensagens'}
          aria-label="Mensagem"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_CHAT_TEXT_LEN}
          disabled={!connected}
          className="chat-form__input"
        />
        <div className="chat-emoji" onKeyDown={(e) => { if (e.key === 'Escape') setEmojiOpen(false); }}>
          <button
            type="button"
            className="chat-form__emoji"
            aria-label="Inserir emoji"
            aria-haspopup="true"
            aria-expanded={emojiOpen}
            disabled={!connected}
            onClick={() => setEmojiOpen((o) => !o)}
          >
            <EmojiIcon size={22} />
          </button>
          {emojiOpen && (
            <div className="chat-emoji__pop" role="group" aria-label="Emojis">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`Inserir ${e}`}
                  onClick={() => {
                    setDraft((d) => (d + e).slice(0, MAX_CHAT_TEXT_LEN));
                    setEmojiOpen(false);
                    inputRef.current?.focus();
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={!connected || !draft.trim() || sending}
          title={connected ? 'Enviar' : 'Reconecte para enviar mensagens'}
          aria-label="Enviar"
          className="chat-form__send"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
