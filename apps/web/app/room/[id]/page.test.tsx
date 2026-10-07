import { describe, it, expect, vi, beforeEach } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
vi.mock('./client', () => ({ RoomClient: (props: { roomId: string }) => props }));

import RoomPage from './page';

describe('RoomPage', () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it('redirects a lowercase room id to its canonical uppercase URL', async () => {
    await expect(RoomPage({ params: Promise.resolve({ id: 'abc123' }) })).rejects.toThrow(
      'NEXT_REDIRECT /room/ABC123',
    );
    expect(redirect).toHaveBeenCalledWith('/room/ABC123');
  });

  it('renders the room for an already canonical id', async () => {
    const el = (await RoomPage({ params: Promise.resolve({ id: 'ABC123' }) })) as { props: { roomId: string } };
    expect(redirect).not.toHaveBeenCalled();
    expect(el.props.roomId).toBe('ABC123');
  });
});
