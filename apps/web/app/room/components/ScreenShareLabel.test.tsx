import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ScreenShareState } from '@cojam/shared';
import { ScreenSharePanelView, type ScreenShare } from './ScreenSharePanel';
import { useStore } from '@/lib/realtime';
import { DEFAULT_QUALITY } from '@/lib/screenShare';

const live = (over: Partial<ScreenShareState> = {}): ScreenShareState => ({
  broadcasterId: 'b1',
  broadcasterName: 'Ana',
  startedAtMs: 1,
  viewerCount: 0,
  maxViewers: 5,
  locked: false,
  ...over,
});

function share(over: Partial<ScreenShare>): ScreenShare {
  return {
    role: 'idle',
    busy: false,
    error: '',
    notice: '',
    localStream: null,
    remoteStream: null,
    viewerState: null,
    viewerIds: [],
    lastWatchedAt: null,
    isBroadcaster: false,
    quality: DEFAULT_QUALITY,
    limitation: null,
    setLabel: vi.fn(async () => true),
    ...over,
  } as unknown as ScreenShare;
}

function show(s: ScreenShare) {
  useStore.setState({
    state: { roomId: 'ROOM00000001', queue: [], radioEnabled: false, version: 1, screen: s.screen },
  });
  render(<ScreenSharePanelView roomId="ROOM00000001" canModerate={false} isPublic={false} share={s} />);
}

afterEach(cleanup);

describe('what is on screen (spec 5.7)', () => {
  it('shows the label on the card before watching', () => {
    show(share({ screen: live({ label: 'Revisão do projeto' }) }));
    expect(screen.getByTestId('screen-share-label').textContent).toBe('Mostrando: Revisão do projeto');
  });

  it('shows nothing extra without a label', () => {
    show(share({ screen: live() }));
    expect(screen.queryByTestId('screen-share-label')).toBeNull();
  });

  it('lets the broadcaster set it', async () => {
    const s = share({ screen: live(), role: 'broadcasting', isBroadcaster: true });
    show(s);
    const input = screen.getByRole('textbox', { name: /O que você está mostrando/ }) as HTMLInputElement;
    expect(input.maxLength).toBe(60);
    fireEvent.change(input, { target: { value: 'Filme da noite' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(s.setLabel).toHaveBeenCalledWith('Filme da noite'));
  });
});
