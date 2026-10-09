import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TermsPage, { metadata } from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('TermsPage', () => {
  it('shows the draft banner and the main sections', () => {
    render(<TermsPage />);
    expect(screen.getByText('Rascunho para revisão jurídica')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Termos de Uso' })).toBeTruthy();
    for (const h of [/Idade mínima/, /Uso aceitável/, /Moderação e remoção/]) {
      expect(screen.getByRole('heading', { level: 2, name: h })).toBeTruthy();
    }
  });

  it('states metadata-only, never audio', () => {
    const { container } = render(<TermsPage />);
    expect(container.textContent).toContain('nunca transmite áudio');
  });

  it('is indexable with a canonical', () => {
    expect(metadata.alternates?.canonical).toBe('/termos');
    expect(metadata.robots).toMatchObject({ index: true });
  });

  it('has the band scene naming the page, a table of contents and the text on a plate', () => {
    const { container } = render(<TermsPage />);
    expect(container.querySelector('.pws__v--wide .pws-led')?.getAttribute('data-led')).toBe('TERMOS / DE USO');
    const toc = screen.getByRole('navigation', { name: 'Nesta página' });
    expect(toc.querySelectorAll('li').length).toBe(10);
    const first = toc.querySelector('a[href^="#"]') as HTMLAnchorElement;
    expect(container.querySelector(first.getAttribute('href')!)).toHaveTextContent('1. O que é o CoJam');
    expect(container.querySelector('main.pw-plate')).not.toBeNull();
    expect(container.querySelectorAll('h1').length).toBe(1);
  });
});
