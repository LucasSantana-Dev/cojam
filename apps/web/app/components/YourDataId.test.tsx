import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { YourDataId } from './YourDataId';

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

// #318: the guest id is the only thing that ties a person to their data, and
// it lives only in their browser. This is how they find it to ask for erasure.
describe('YourDataId', () => {
  it('renders nothing for a visitor who never joined a room', () => {
    const { container } = render(<YourDataId />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the stored guest id with the erasure instructions', async () => {
    window.localStorage.setItem('cojam_uid', 'guestid123');
    render(<YourDataId />);

    expect(await screen.findByText('Seus dados')).toBeInTheDocument();
    expect(screen.getByText('guestid123')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Para pedir a exclusão dos seus dados, envie este código para o contato da política de privacidade.',
      ),
    ).toBeInTheDocument();
  });

  it('copies the id to the clipboard', async () => {
    window.localStorage.setItem('cojam_uid', 'guestid123');
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<YourDataId />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copiar código' }));

    expect(writeText).toHaveBeenCalledWith('guestid123');
    expect(await screen.findByRole('button', { name: 'Código copiado' })).toBeInTheDocument();
  });

  it('inline: explains there is nothing to erase when no id is stored', () => {
    render(<YourDataId inline />);
    expect(screen.getByText(/não guarda um código/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copiar código' })).not.toBeInTheDocument();
  });

  it('inline: shows the id and copy button without the details wrapper', async () => {
    window.localStorage.setItem('cojam_uid', 'guestid123');
    const { container } = render(<YourDataId inline />);
    expect(await screen.findByText('guestid123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeInTheDocument();
    expect(container.querySelector('details')).toBeNull();
  });
});
