import type { Metadata } from 'next';
import { PalcoScene } from '@/app/components/PalcoScene';
import { PalcoBrandBar } from '@/app/components/PalcoShell';
import { OfflineRetry } from './OfflineRetry';

// Static on purpose: no data, no realtime. The service worker precaches this
// page on install and serves it when a navigation fails without a connection.
// It also precaches the two callback scene PNGs this page paints (public/sw.js,
// SCENE_ASSETS): change the scene here and change that list with it.
export const metadata: Metadata = {
  title: 'Sem sinal',
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <div className="pw">
      <PalcoBrandBar />
      <PalcoScene kind="callback" led={{ title: 'SEM REDE', scale: 3, sub: 'Sem conexao' }}>
        <main id="main" className="pw-dock pw-plate">
          <div className="pw-dock__copy">
            <p className="pw-eyebrow">Offline</p>
            <h1 className="pw-title">Sem sinal</h1>
            <p className="pw-text">Você está sem internet. A sala volta assim que a conexão voltar.</p>
          </div>
          <div className="pw-actions">
            <OfflineRetry />
          </div>
        </main>
      </PalcoScene>
    </div>
  );
}
