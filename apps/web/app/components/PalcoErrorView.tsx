import type { ReactNode } from 'react';
import { PalcoScene } from '@/app/components/PalcoScene';

// The erro screen: the scene with the lights down and one bottom plate. Shared by
// error.tsx (inside the app layout) and global-error.tsx (which replaces it, so the
// brand and the home link are passed in: a plain <a> there, a next/link here).
// No codes or digests are shown (DESIGN.md, Copy).
export function PalcoErrorView({
  brand,
  home,
  reset,
}: {
  brand: ReactNode;
  home: ReactNode;
  reset: () => void;
}) {
  return (
    <div className="pw">
      <header className="pw-bar pw-bar--over">{brand}</header>
      <PalcoScene kind="erro">
        <main id="main" className="pw-dock pw-plate">
          <div className="pw-dock__copy">
            <p className="pw-eyebrow">Caiu o som · do nosso lado</p>
            <h1 className="pw-title">A plateia está esperando</h1>
            <p className="pw-text">
              Deu um problema aqui, não com você. A sala e a fila estão guardadas no servidor.
            </p>
          </div>
          <div className="pw-actions">
            {home}
            <button type="button" onClick={reset} className="pw-btn">
              Tentar de novo
            </button>
          </div>
        </main>
      </PalcoScene>
    </div>
  );
}
