import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useReportDialog, type ReportTarget } from './useReportDialog';

type ReportInput = Parameters<typeof import('@/lib/report').fileReport>[0];
const fileReport = vi.fn(async (input: ReportInput) => Boolean(input));
vi.mock('@/lib/report', () => ({ fileReport: (input: ReportInput) => fileReport(input) }));

function Harness({ target }: { target: ReportTarget }) {
  const report = useReportDialog();
  return (
    <>
      <button onClick={() => report.open(target)}>abrir</button>
      {report.dialog}
    </>
  );
}

describe('useReportDialog (#259)', () => {
  beforeEach(() => {
    fileReport.mockReset();
    fileReport.mockImplementation(async (input) => Boolean(input));
  });

  it('files a room report with the chosen category, no account needed', async () => {
    render(<Harness target={{ roomId: 'R1', kind: 'room' }} />);
    fireEvent.click(screen.getByText('abrir'));
    expect(screen.getByRole('heading', { name: 'Denunciar sala' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'sexual_content' } });
    fireEvent.change(screen.getByLabelText('Detalhes (opcional)'), { target: { value: ' nome impróprio ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar denúncia' }));
    });

    expect(fileReport).toHaveBeenCalledTimes(1);
    expect(fileReport.mock.calls[0][0]).toMatchObject({
      roomId: 'R1',
      kind: 'room',
      category: 'sexual_content',
      reason: 'nome impróprio',
    });
    expect(await screen.findByText(/Denúncia enviada/)).toBeInTheDocument();
  });

  it('files a user report carrying the member id and name', async () => {
    render(
      <Harness target={{ roomId: 'R1', kind: 'member', subjectId: 'c-9', subjectLabel: 'Ana' }} />,
    );
    fireEvent.click(screen.getByText('abrir'));
    expect(screen.getByRole('heading', { name: 'Denunciar usuário' })).toBeInTheDocument();
    expect(screen.getByText(/Você está denunciando Ana/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar denúncia' }));
    });
    expect(fileReport.mock.calls[0][0]).toMatchObject({
      roomId: 'R1',
      kind: 'member',
      subjectId: 'c-9',
      content: 'Ana',
      category: 'other',
    });
  });

  it('shows an error and allows a retry when filing fails', async () => {
    fileReport.mockResolvedValueOnce(false);
    render(<Harness target={{ roomId: 'R1', kind: 'room' }} />);
    fireEvent.click(screen.getByText('abrir'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar denúncia' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível enviar');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar denúncia' }));
    });
    await waitFor(() => expect(screen.getByText(/Denúncia enviada/)).toBeInTheDocument());
    expect(fileReport).toHaveBeenCalledTimes(2);
  });
});
