import type { Metadata } from 'next';
import { OfflineRetry } from './OfflineRetry';

// Static on purpose: no data, no realtime. The service worker precaches this
// page on install and serves it when a navigation fails without a connection.
export const metadata: Metadata = {
  title: 'Sem sinal',
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <div className="sx" data-bg="sintonia">
      <main id="main" className="sx-main">
        <div className="sx-glass sx-card">
          <p className="sx-eyebrow">Offline</p>
          <h1 className="sx-title">Sem sinal</h1>
          <p className="sx-text">Você está sem internet. A sala volta assim que a conexão voltar.</p>
          <div className="sx-actions">
            <OfflineRetry />
          </div>
        </div>
      </main>
    </div>
  );
}
