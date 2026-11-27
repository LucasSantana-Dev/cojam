import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ScreenShareState } from '@cojam/shared';
import { ScreenSharePanelView, type ScreenShare } from './ScreenSharePanel';
import { useStore } from '@/lib/realtime';
import { DEFAULT_QUALITY } from '@/lib/screenShare';

const live: ScreenShareState = {
  broadcasterId: 'b1',
  broadcasterName: 'Ana',
  startedAtMs: 1,
  viewerCount: 1,
  maxViewers: 5,
  locked: false,
};

function watching(health: 'frozen' | 'weak' | null): ScreenShare {
  return {
    screen: live,
    role: 'watching',
    busy: false,
    error: '',
    notice: '',
    localStream: null,
    remoteStream: null,
    viewerState: 'connected',
    viewerIds: [],
    lastWatchedAt: null,
    isBroadcaster: false,
    quality: DEFAULT_QUALITY,
    limitation: null,
    health,
  } as unknown as ScreenShare;
}

afterEach(cleanup);

describe('viewer connection notice (spec 5.7)', () => {
  const show = (health: 'frozen' | 'weak' | null) => {
    useStore.setState({ state: { roomId: 'ROOM00000001', queue: [], radioEnabled: false, version: 1, screen: live } });
    render(<ScreenSharePanelView roomId="ROOM00000001" canModerate={false} isPublic={false} share={watching(health)} />);
  };

  it('says when the image froze', () => {
    show('frozen');
    expect(screen.getByTestId('screen-share-health').textContent).toBe(
      'A imagem parou. Pode ser a conexão de Ana ou a sua.',
    );
  });

  it('says when the connection is weak', () => {
    show('weak');
    expect(screen.getByTestId('screen-share-health').textContent).toContain('Conexão fraca');
  });

  it('says nothing when the image is fine', () => {
    show(null);
    expect(screen.queryByTestId('screen-share-health')).toBeNull();
  });
});
