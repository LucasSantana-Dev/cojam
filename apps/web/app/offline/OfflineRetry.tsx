'use client';

export function OfflineRetry() {
  return (
    <button type="button" className="pw-btn" onClick={() => window.location.reload()}>
      Tentar de novo
    </button>
  );
}
