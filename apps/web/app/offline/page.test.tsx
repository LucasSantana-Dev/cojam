import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import OfflinePage, { metadata } from './page';

describe('/offline', () => {
  it('is noindex and shows the PT-BR message with a retry button', () => {
    expect(metadata.robots).toMatchObject({ index: false });
    render(<OfflinePage />);
    expect(screen.getByRole('heading', { name: 'Sem sinal' })).toBeInTheDocument();
    expect(screen.getByText(/sem internet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
  });
});
