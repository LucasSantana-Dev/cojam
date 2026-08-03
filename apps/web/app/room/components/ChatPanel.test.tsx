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

// Auto-scroll gating (#189). jsdom does not lay out, so scroll metrics are
// stubbed per test to give the near-bottom math real numbers.
describe('ChatPanel auto-scroll (#189)', () => {
  const scrollList = (container: HTMLElement) =>
    container.querySelector('.overflow-y-auto') as HTMLElement;

  const stubMetrics = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  };

  beforeEach(() => {
    useStore.setState({ chat: [], connected: true, name: 'Ana' });
  });

  it('preserves a scrolled-up reading position when a message arrives', () => {
    useStore.setState({ chat: [msg('m1', 'first')] });
    const { container } = render(<ChatPanel roomId="r1" />);
    const list = scrollList(container);
    stubMetrics(list, 1000, 200);
    // The user scrolls up to read history (700px above the bottom).
    fireEvent.scroll(list, { target: { scrollTop: 100 } });

    act(() => useStore.getState().addChatMessage(msg('m2', 'second')));

    expect(list.scrollTop).toBe(100);
  });

  it('follows new messages when the user is at the bottom', () => {
    useStore.setState({ chat: [msg('m1', 'first')] });
    const { container } = render(<ChatPanel roomId="r1" />);
    const list = scrollList(container);
    stubMetrics(list, 1000, 200);
    // At the bottom: scrollHeight - scrollTop - clientHeight = 0 <= 80px.
    fireEvent.scroll(list, { target: { scrollTop: 800 } });

    act(() => useStore.getState().addChatMessage(msg('m2', 'second')));

    expect(list.scrollTop).toBe(1000);
  });

  it('resumes following once the user scrolls back near the bottom', () => {
    useStore.setState({ chat: [msg('m1', 'first')] });
    const { container } = render(<ChatPanel roomId="r1" />);
    const list = scrollList(container);
    stubMetrics(list, 1000, 200);
    fireEvent.scroll(list, { target: { scrollTop: 100 } });
    act(() => useStore.getState().addChatMessage(msg('m2', 'second')));
    expect(list.scrollTop).toBe(100);

    // Back within the 80px threshold: 1000 - 750 - 200 = 50.
    fireEvent.scroll(list, { target: { scrollTop: 750 } });
    act(() => useStore.getState().addChatMessage(msg('m3', 'third')));
    expect(list.scrollTop).toBe(1000);
  });
});
