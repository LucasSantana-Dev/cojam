import Link from 'next/link';
import { R4Brand, R4Footer } from '@/app/components/R4Shell';

// Shared shell for the legal pages (#253). Static, no client JS. Round-4 shell:
// ink base, top bar, readable text column in a panel.
export const LEGAL_DRAFT_DATE = '2026-10-07';

export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <div className="r4s">
      <header className="r4s-bar">
        <R4Brand />
        <nav aria-label="Navegação" className="r4s-nav">
          <Link href="/privacidade">Privacidade</Link>
          <Link href="/termos">Termos</Link>
        </nav>
        <Link href="/" className="r4s-btn r4s-btn--sm">Começar uma sala</Link>
      </header>
      <main id="main" className="legal r4s-panel" lang="pt-BR">
        <p role="note" className="legal-banner">
          <strong>Rascunho para revisão jurídica</strong> ({LEGAL_DRAFT_DATE}). Este texto não é
          aconselhamento jurídico e ainda não foi revisado por advogado. Trechos entre{' '}
          <code>[[colchetes duplos]]</code> estão pendentes de preenchimento.
        </p>
        <h1>{title}</h1>
        <p className="legal-meta">Última atualização: {LEGAL_DRAFT_DATE}</p>
        <p>{intro}</p>
        {children}
      </main>
      <R4Footer />
    </div>
  );
}
