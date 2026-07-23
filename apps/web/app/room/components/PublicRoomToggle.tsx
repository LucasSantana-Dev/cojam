'use client';

import { useEffect, useState } from 'react';
import { useStore, setRoomPublic, rpcErrorMessage } from '@/lib/realtime';

// Host-only directory opt-in (F1): toggles the room's public listing and
// carries the optional directory label. Rendered only when hostControl and
// the publicRooms flag are on; the server enforces both gates authoritatively
// (room.set_public is membership + host gated, ErrorMethodNotFound when off).
export function PublicRoomToggle({ roomId }: { roomId: string }) {
  const isPublic = useStore((s) => s.state?.public ?? false);
  const savedName = useStore((s) => s.state?.name ?? '');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Prefill the label from the room state once it is known; never overwrite
  // what the host is typing.
  useEffect(() => {
    if (isPublic) setLabel((l) => (l === '' ? savedName : l));
  }, [isPublic, savedName]);

  const send = async (next: boolean, name?: string) => {
    setBusy(true);
    setError('');
    try {
      await setRoomPublic(roomId, next, name);
    } catch (err) {
      setError(rpcErrorMessage(err, 'Could not update the public listing'));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    // Enabling sends a non-empty label; otherwise name is omitted so any
    // saved label is kept. Disabling leaves the saved label on the room.
    void send(next, next && label.trim() ? label.trim() : undefined);
  };

  const commitLabel = () => {
    const trimmed = label.trim();
    if (trimmed === savedName) return;
    void send(true, trimmed); // empty after trim clears the label server-side
  };

  return (
    <span className="inline-flex items-center gap-2">
      <label
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium cursor-pointer"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
      >
        <input type="checkbox" checked={isPublic} disabled={busy} onChange={onToggle} />
        Public
      </label>
      {isPublic && (
        <input
          type="text"
          value={label}
          maxLength={60}
          placeholder="Room label (optional)"
          aria-label="Public room label"
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel();
          }}
          className="px-3 py-2 rounded-lg text-sm"
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            width: '11rem',
          }}
        />
      )}
      {error && (
        <span role="alert" className="text-xs" style={{ color: 'var(--color-status-error)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
