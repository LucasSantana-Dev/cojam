import Link from 'next/link';
import { LogoMark } from '@/app/components/Logo';

// Shared pieces of the round-4 screens outside the room (landing, /rooms, legal).
// Tokens and classes live in the "Telas, round 4" block of globals.css.

export const GITHUB_URL = 'https://github.com/LucasSantana-Dev/cojam';

export function R4Brand({ tagline = false }: { tagline?: boolean }) {
  return (
    <span className="r4s-brand">
      <Link href="/" className="r4s-brand__logo" aria-label="CoJam, início">
        <LogoMark size={40} />
        <span className="r4s-brand__word">CoJam</span>
      </Link>
      {tagline && (
        <>
          <span className="r4s-divider" aria-hidden />
          <span className="r4s-brand__tag">O seu app de música com amigos</span>
        </>
      )}
    </span>
  );
}

export function R4Footer() {
  return (
    <footer className="r4s-footer">
      <p className="r4s-footer__links">
        Feito em público ·{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
        {' · '}
        <Link href="/privacidade">Privacidade</Link>
        {' · '}
        <Link href="/termos">Termos</Link>
        {' · '}
        <Link href="/privacidade#excluir-seus-dados">Seus dados</Link>
      </p>
      <p className="r4s-footer__mark">
        <LogoMark size={20} /> CoJam © {new Date().getFullYear()}
      </p>
    </footer>
  );
}
