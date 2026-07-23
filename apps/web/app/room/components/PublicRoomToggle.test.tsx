import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublicRoomToggle } from './PublicRoomToggle';
import { useStore } from '@/lib/realtime';
import type { RoomState } from '@cojam/shared';

// Only the RPC wrapper is mocked; the component drives the real zustand store
// (seeded per case) so checked state and label prefill flow like in the app.
const rpcMocks = vi.hoisted(() => ({
  setRoomPublic: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  setRoomPublic: rpcMocks.setRoomPublic,
}));

const state = (over: Partial<RoomState> = {}): RoomState => ({
  roomId: 'room-1',
  queue: [],
  radioEnabled: false,
  version: 1,
  ...over,
});

describe('PublicRoomToggle', () => {
  beforeEach(() => {
    rpcMocks.setRoomPublic.mockReset();
    useStore.setState({ state: state({ public: false }) });
  });

  it('enabling sends public:true with no name when the label is empty', async () => {
    render(<PublicRoomToggle roomId="room-1" />);

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(rpcMocks.setRoomPublic).toHaveBeenCalledWith('room-1', true, undefined);
    });
  });

  it('disabling sends public:false and leaves the saved label untouched', async () => {
    useStore.setState({ state: state({ public: true, name: 'Neon' }) });
    render(<PublicRoomToggle roomId="room-1" />);

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(rpcMocks.setRoomPublic).toHaveBeenCalledWith('room-1', false, undefined);
    });
  });

  it('commits a trimmed label on blur', async () => {
    useStore.setState({ state: state({ public: true, name: 'Neon' }) });
    render(<PublicRoomToggle roomId="room-1" />);

    const input = screen.getByRole('textbox', { name: 'Public room label' });
    // Prefilled from the room state.
    await waitFor(() => expect(input).toHaveValue('Neon'));

    fireEvent.change(input, { target: { value: '  Neon Nights  ' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(rpcMocks.setRoomPublic).toHaveBeenCalledWith('room-1', true, 'Neon Nights');
    });
  });

  it('commits the label on Enter', async () => {
    useStore.setState({ state: state({ public: true, name: '' }) });
    render(<PublicRoomToggle roomId="room-1" />);

    const input = screen.getByRole('textbox', { name: 'Public room label' });
    fireEvent.change(input, { target: { value: 'Late Night' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(rpcMocks.setRoomPublic).toHaveBeenCalledWith('room-1', true, 'Late Night');
    });
  });

  it('does not re-send when the label is unchanged', async () => {
    useStore.setState({ state: state({ public: true, name: 'Neon' }) });
    render(<PublicRoomToggle roomId="room-1" />);

    const input = screen.getByRole('textbox', { name: 'Public room label' });
    await waitFor(() => expect(input).toHaveValue('Neon'));
    fireEvent.blur(input);

    // Wait a microtask turn; no RPC should fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(rpcMocks.setRoomPublic).not.toHaveBeenCalled();
  });

  it('disables the checkbox while a send is in flight', async () => {
    let resolveSend: () => void = () => {};
    rpcMocks.setRoomPublic.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    );
    render(<PublicRoomToggle roomId="room-1" />);

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeDisabled());
    resolveSend();
    await waitFor(() => expect(checkbox).not.toBeDisabled());
  });

  it('shows the server message when the RPC fails', async () => {
    rpcMocks.setRoomPublic.mockRejectedValueOnce(new Error('not the host'));
    render(<PublicRoomToggle roomId="room-1" />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(await screen.findByRole('alert')).toHaveTextContent('not the host');
  });
});
