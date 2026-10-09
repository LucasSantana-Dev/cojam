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

  it('is indexable with a canonical', () => {
    expect(metadata.alternates?.canonical).toBe('/privacidade');
    expect(metadata.robots).toMatchObject({ index: true });
  });
});
