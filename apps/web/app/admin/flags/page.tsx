import type { Metadata } from 'next';
import { PalcoBrandBar, PalcoFooter } from '@/app/components/PalcoShell';
import { PalcoNav } from '@/app/components/PalcoNav';
import { PalcoScene } from '@/app/components/PalcoScene';
import { FlagsPanel } from './FlagsPanel';

export const metadata: Metadata = {
  title: 'Feature flags',
  robots: { index: false, follow: false },
};

// Owner-only switchboard for the runtime feature flags. The page itself is
// public and holds no data: everything comes from /api/admin/flags behind
// ADMIN_TOKEN (docs/specs/feature-flags-panel.md).
export default function AdminFlagsPage() {
  return (
    <div className="pw pwa">
      <PalcoBrandBar>
        <PalcoNav />
      </PalcoBrandBar>
      <PalcoScene kind="band" led={{ title: 'ADMIN', scale: 2, sub: 'FEATURE FLAGS' }} />
      <main id="main" className="pwa-main">
        <FlagsPanel />
      </main>
      <PalcoFooter />
    </div>
  );
}
