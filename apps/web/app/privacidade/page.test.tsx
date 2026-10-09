import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrivacyPage, { metadata } from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('PrivacyPage', () => {
  it('shows the draft banner and the main sections', () => {
    render(<PrivacyPage />);
    expect(screen.getByText('Rascunho para revisão jurídica')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Política de Privacidade' })).toBeTruthy();
    for (const h of [/Retenção/, /Com quem os dados/, /Seus direitos/, /Crianças e adolescentes/]) {
      expect(screen.getByRole('heading', { level: 2, name: h })).toBeTruthy();
    }
  });

  it('leaves grep-able placeholders unfilled', () => {
    const { container } = render(<PrivacyPage />);
    expect(container.textContent).toContain('[[EMAIL DE CONTATO DPO]]');
    expect(container.textContent).toContain('[[CONTROLADOR: nome]]');
  });

  it('discloses the product events: what is recorded, what is not, basis, retention, objection', () => {
    const { container } = render(<PrivacyPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('Eventos de uso pseudonimizados');
    expect(text).toContain('Entender como o CoJam é usado e melhorar o produto');
    expect(text).toMatch(/Legítimo interesse \(IX\)/);
    expect(text).toContain('13 meses');
    expect(text).toContain('Nunca registrado nesses eventos');
    for (const never of ['endereço IP', 'nome de exibição', 'mensagens de chat', 'o texto das buscas', 'o código da sala em claro']) {
      expect(text).toContain(never);
    }
    expect(text).toContain('Oposição aos eventos de uso');
  });

  it('no longer promises that only counts are collected', () => {
    const { container } = render(<PrivacyPage />);
    expect(container.textContent).not.toMatch(/apenas contagens|só contagens|somente contagens/i);
  });

  it('is indexable with a canonical', () => {
    expect(metadata.alternates?.canonical).toBe('/privacidade');
    expect(metadata.robots).toMatchObject({ index: true });
  });
});
