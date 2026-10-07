import Link from 'next/link';

// Shared shell for the legal pages (#253). Static, no client JS.
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
    <main id="main" className="legal" lang="pt-BR">
      <p role="note" className="legal-banner">
        <strong>Rascunho para revisão jurídica</strong> ({LEGAL_DRAFT_DATE}). Este texto não é
        aconselhamento jurídico e ainda não foi revisado por advogado. Trechos entre{' '}
        <code>[[colchetes duplos]]</code> estão pendentes de preenchimento.
      </p>
      <nav aria-label="Navegação" className="legal-nav">
        <Link href="/">CoJam</Link>
        <Link href="/privacidade">Privacidade</Link>
        <Link href="/termos">Termos</Link>
      </nav>
      <h1>{title}</h1>
      <p className="legal-meta">Última atualização: {LEGAL_DRAFT_DATE}</p>
      <p>{intro}</p>
      {children}
    </main>
  );
}
