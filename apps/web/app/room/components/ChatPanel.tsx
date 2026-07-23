'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useStore, sendChat, rpcErrorMessage, getClockOffsetMs } from '@/lib/realtime';
import { formatRelativeTime } from '@/lib/relativeTime';
import { avatarGradient } from '@/lib/avatar';

// Server caps chat text at 300 chars (F8); the input enforces the same limit
// so the client never ships a message the server would reject.
const MAX_CHAT_TEXT_LEN = 300;

// sentAtServerMs is server time; apply the measured offset (clockSync) before
// diffing so skewed client clocks do not show fake relative times.
function chatTime(sentAtServerMs: number): string {
  return formatRelativeTime(sentAtServerMs, Date.now() + getClockOffsetMs()) ?? '';
}

interface ChatPanelProps {
  roomId: string;
}

export function ChatPanel({ roomId }: ChatPanelProps) {
  const chat = useStore((s) => s.chat);
  const connected = useStore((s) => s.connected);
  const name = useStore((s) => s.name);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest line whenever the list grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

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
      setActionError(rpcErrorMessage(err, 'Couldn\'t send that message. Try again.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel p-6 space-y-4 h-fit mt-6">
      <div>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Chat
        </h3>
      </div>

      {actionError && (
        <p role="alert" aria-live="polite" className="text-sm" style={{ color: 'var(--color-status-error)' }}>
          {actionError}
        </p>
      )}

      {chat.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            No messages yet. Say hi.
          </p>
          {!connected && (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              You&apos;re disconnected; reconnect to send messages.
            </p>
          )}
        </div>
      ) : (
        <div ref={listRef} className="space-y-3 max-h-80 overflow-y-auto pr-2" aria-live="polite">
          {chat.map((m) => (
            <div key={m.id} data-testid="chat-message" className="flex items-start gap-2">
              <span
                className="avatar-chip flex-shrink-0"
                style={{ background: avatarGradient(m.userId || m.name) }}
                aria-hidden
              >
                {m.name.charAt(0).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                    {m.name}
                  </span>
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {chatTime(m.sentAtServerMs)}
                  </span>
                </div>
                <p className="text-sm break-words" style={{ color: 'var(--color-text-primary)' }}>
                  {m.text}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSend} className="flex gap-2">
        <input
          type="text"
          placeholder={connected ? 'Message' : 'Reconnect to send messages'}
          aria-label="Message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_CHAT_TEXT_LEN}
          disabled={!connected}
          className="flex-1 min-w-0 px-4 py-2 text-sm rounded-lg focus:outline-none transition-all duration-150 disabled:opacity-50"
          style={{ backgroundColor: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
        />
        <button
          type="submit"
          disabled={!connected || !draft.trim() || sending}
          title={connected ? 'Send' : 'Reconnect to send messages'}
          className="px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-150 hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none"
          style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
