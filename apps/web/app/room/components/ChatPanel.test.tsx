import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import { useStore } from '@/lib/realtime';
import type { ChatMessage } from '@cojam/shared';

// Only the RPC function is mocked; the component drives the real zustand
// store (seeded below) so the render reflects actual app state flow.
const rpcMocks = vi.hoisted(() => ({
  sendChat: vi.fn(async (_roomId: string, _text: string, name: string): Promise<ChatMessage> => ({
    id: 'srv-1',
    roomId: 'r1',
    name,
    text: 'hi',
    sentAtServerMs: 1,
  })),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  sendChat: rpcMocks.sendChat,
}));

const msg = (id: string, text: string, name = 'Ana'): ChatMessage => ({
  id,
  roomId: 'r1',
  name,
  text,
  sentAtServerMs: Date.now(),
});

describe('ChatPanel', () => {
  beforeEach(() => {
    useStore.setState({ chat: [], connected: true, name: 'Ana' });
    rpcMocks.sendChat.mockClear();
  });

  it('renders the empty state', () => {
    render(<ChatPanel roomId="r1" />);
    expect(screen.getByText('No messages yet. Say hi.')).toBeInTheDocument();
  });

  it('explains the disabled input when disconnected', () => {
    useStore.setState({ connected: false });
    render(<ChatPanel roomId="r1" />);
    expect(screen.getByText(/reconnect to send messages/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('renders messages from the store with sender name', () => {
    useStore.setState({ chat: [msg('m1', 'hello room')] });
    render(<ChatPanel roomId="r1" />);
    expect(screen.getByText('hello room')).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it('sends the trimmed text with the joined name and clears the input', async () => {
    render(<ChatPanel roomId="r1" />);
    const input = screen.getByLabelText('Message');

    fireEvent.change(input, { target: { value: '  hi there  ' } });
    fireEvent.submit(input.closest('form')!);
    await act(async () => {});

    expect(rpcMocks.sendChat).toHaveBeenCalledWith('r1', 'hi there', 'Ana');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('does not send empty or whitespace-only text', async () => {
    render(<ChatPanel roomId="r1" />);
    const input = screen.getByLabelText('Message');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    await act(async () => {});

    expect(rpcMocks.sendChat).not.toHaveBeenCalled();
  });

  it('shows the server error inline on rejection and keeps the draft', async () => {
    rpcMocks.sendChat.mockRejectedValueOnce({ code: 400, message: 'too many requests, slow down' });
    render(<ChatPanel roomId="r1" />);
    const input = screen.getByLabelText('Message');

    fireEvent.change(input, { target: { value: 'spam' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('too many requests, slow down');
    // The draft stays so the user can retry once the limiter window passes.
    expect((input as HTMLInputElement).value).toBe('spam');
  });
});
