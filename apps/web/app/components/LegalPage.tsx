import { Children, cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import Link from 'next/link';
import { PalcoScene } from '@/app/components/PalcoScene';
import { PalcoBrandBar, PalcoFooter } from '@/app/components/PalcoShell';
import { PalcoNav } from '@/app/components/PalcoNav';

// Shared shell for the legal pages (#253). Static, no client JS of its own. Palco screen
// (wave 2): the band scene with the page name on the stage screen, a table of contents
// from 64rem, and the text on one readable plate.
export const LEGAL_DRAFT_DATE = '2026-10-07';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface Section {
  id: string;
  title: string;
}

// Every top-level h2 becomes a table-of-contents entry; one without an id gets a slug (prefixed, so it never starts with a digit).
function withSections(children: ReactNode): { body: ReactNode[]; sections: Section[] } {
  const sections: Section[] = [];
  const body = Children.toArray(children).map((child) => {
    if (!isValidElement<{ id?: string; children?: ReactNode }>(child) || child.type !== 'h2') return child;
    const title = textOf(child.props.children).trim();
    const id = child.props.id ?? `secao-${slug(title)}`;
    sections.push({ id, title });
    return child.props.id ? child : cloneElement(child as ReactElement<{ id?: string }>, { id });
  });
  return { body, sections };
}

export function LegalPage({
  title,
  led,
  intro,
  children,
}: {
  title: string;
  /** What the stage screen reads: the page name, and a short second line. */
  led: { title: string; sub: string };
  intro: string;
  children: React.ReactNode;
}) {
  const { body, sections } = withSections(children);
  const other = title.startsWith('Termos')
    ? { href: '/privacidade', label: 'Privacidade' }
    : { href: '/termos', label: 'Termos de Uso' };
  return (
    <div className="pw pwl">
      <PalcoBrandBar>
        <PalcoNav create />
      </PalcoBrandBar>
      <PalcoScene kind="band-text" led={{ title: led.title, scale: 2, sub: led.sub }} />
      <div className="pwl-layout">
        <nav className="pwl-toc pw-plate" aria-label="Nesta página">
          <p className="pw-eyebrow">Nesta página</p>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
          <Link href={other.href} className="pwl-toc__other">{other.label}</Link>
        </nav>
        <main id="main" className="legal pwl-article pw-plate" lang="pt-BR">
          <p role="note" className="legal-banner">
            <strong>Rascunho para revisão jurídica</strong> ({LEGAL_DRAFT_DATE}). Este texto não é
            aconselhamento jurídico e ainda não foi revisado por advogado. Trechos entre{' '}
            <code>[[colchetes duplos]]</code> estão pendentes de preenchimento.
          </p>
          <h1>{title}</h1>
          <p className="legal-meta">Última atualização: {LEGAL_DRAFT_DATE}</p>
          <p>{intro}</p>
          {body}
        </main>
      </div>
      <PalcoFooter />
    </div>
  );
}
