import type { ReactNode } from 'react';
import Link from 'next/link';
import { LogoMark } from '@/app/components/Logo';

// Brand lockup for the palco screens: the mark and the wordmark,
// linking home.
export function PalcoBrand() {
  return (
    <Link href="/" className="pw-brand" aria-label="CoJam, início">
      <LogoMark size={36} />
      <span className="pw-brand__word">CoJam</span>
    </Link>
  );
}

export function PalcoBrandBar({ children }: { children?: ReactNode }) {
  return (
    <header className="pw-bar pw-bar--over">
      <PalcoBrand />
      {children}
    </header>
  );
}

const GITHUB_URL = 'https://github.com/LucasSantana-Dev/cojam';

export function PalcoFooter() {
  return (
    <footer className="pw-footer">
      <p>
        Feito em público ·{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        {' · '}
        <Link href="/privacidade">Privacidade</Link>
        {' · '}
        <Link href="/termos">Termos</Link>
        {' · '}
        <Link href="/privacidade#excluir-seus-dados">Seus dados</Link>
      </p>
      <p className="pw-footer__mark">
        <LogoMark size={20} /> CoJam © {new Date().getFullYear()}
      </p>
    </footer>
  );
}
