'use client';

export function OfflineRetry() {
  return (
    <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
      Tentar de novo
    </button>
  );
}
