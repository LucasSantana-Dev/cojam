'use client';

interface ErrorRetryProps {
  error: string;
  onRetry: () => void;
}

// Shared error + retry block for the room side panels: a failed fetch must
// always offer a way to recover, not just render the message.
export function ErrorRetry({ error, onRetry }: ErrorRetryProps) {
  return (
    <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-secondary)' }}>
      <p>{error}</p>
      <button
        onClick={onRetry}
        className="mt-2 text-xs underline hover:opacity-70 transition-opacity"
        style={{ color: 'var(--color-accent)' }}
      >
        Retry
      </button>
    </div>
  );
}
