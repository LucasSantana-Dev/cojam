import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ListenersStage } from './ListenersStage';
import { useStore, setRoomAdmin, transferHost, claimHost, kickMember, rpcErrorMessage, type Member } from '@/lib/realtime';

vi.mock('@/lib/realtime', async (orig) => ({
  ...(await orig<typeof import('@/lib/realtime')>()),
  setRoomAdmin: vi.fn().mockResolvedValue(undefined),
  transferHost: vi.fn().mockResolvedValue(undefined),
  claimHost: vi.fn().mockResolvedValue(undefined),
  kickMember: vi.fn().mockResolvedValue(undefined),
}));

const m = (clientId: string, name: string, platform?: Member['platform']): Member => ({
  clientId,
  name,
  ...(platform ? { platform } : {}),
});

describe('ListenersStage', () => {
  beforeEach(() => {
    useStore.getState().setMembers([]);
  });

  it('disambiguates two members sharing a name by sorted clientId', () => {
    useStore.getState().setMembers([m('b', 'Alice'), m('a', 'Alice')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
  });

  it('shows the suffixed label as visible text and in the report aria-label', () => {
    useStore.getState().setMembers([m('b', 'Alice'), m('a', 'Alice')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByText('Alice (2)', { selector: '.r4-ls__name-text' })).toBeInTheDocument();
    expect(screen.getByLabelText('Denunciar Alice (2)')).toBeInTheDocument();
  });

  it('renders nothing when nobody is connected', () => {
    const { container } = render(<ListenersStage roomId="r" running={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a unique name with no suffix', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Bob')).toBeInTheDocument();
    expect(screen.queryByTitle(/\(2\)/)).not.toBeInTheDocument();
  });

  it('keeps suffixes stable when an unrelated member joins', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<ListenersStage roomId="r" running={false} />);
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();

    act(() => useStore.getState().addMember(m('c', 'Carol')));
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
    expect(screen.getByTitle('Carol')).toBeInTheDocument();
  });

  it('reverts to a bare name after the collision resolves', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<ListenersStage roomId="r" running={false} />);
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();

    act(() => useStore.getState().removeMember('b'));
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.queryByTitle('Alice (2)')).not.toBeInTheDocument();
  });

  it('does not dedupe by name: two same-named members render two chips and count twice', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByText('2 ouvindo')).toBeInTheDocument();
  });

  it('"+N" overflow counts connections, not unique names', () => {
    // 8 connections, two of them the same name: 6 visible, +2 hidden.
    useStore.getState().setMembers([
      m('1', 'Alice'), m('2', 'Alice'), m('3', 'Bo'), m('4', 'Cy'),
      m('5', 'Di'), m('6', 'Ed'), m('7', 'Fi'), m('8', 'Gus'),
    ]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('8 ouvindo')).toBeInTheDocument();
    // Both Alices are inside the visible 6 — no dedupe collapsed them.
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
  });

  it('renders the platform indicator from presence data, and none when unreported', () => {
    useStore.getState().setMembers([m('a', 'Alice', 'spotify'), m('b', 'Bob')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByTitle('Spotify')).toHaveAttribute('data-svc', 'spotify');
    expect(screen.queryByTitle('YouTube')).not.toBeInTheDocument();
  });

  it('lets any member report another member, but not themselves (#259)', () => {
    useStore.setState({ clientId: 'a' });
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByLabelText('Denunciar Bob')).toBeInTheDocument();
    expect(screen.queryByLabelText('Denunciar Alice')).not.toBeInTheDocument();
  });

  it('labels each listener with the service and crowns the host', () => {
    useStore.getState().setMembers([
      { clientId: 'a', userId: 'u1', name: 'Bia', platform: 'spotify' },
      { clientId: 'b', userId: 'u2', name: 'Dani', platform: 'youtube' },
    ]);
    render(<ListenersStage roomId="r" running={false} hostUserId="u1" />);

    expect(screen.getByText('(Spotify)')).toBeInTheDocument();
    expect(screen.getByText('(YouTube)')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Anfitrião' })).toHaveLength(1);
  });

  it('says "em sintonia" only while playing with at least two listeners', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    const { rerender } = render(<ListenersStage roomId="r" running={false} />);
    expect(screen.queryByText('em sintonia')).not.toBeInTheDocument();

    rerender(<ListenersStage roomId="r" running />);
    expect(screen.getByText('em sintonia')).toBeInTheDocument();

    act(() => useStore.getState().removeMember('b'));
    expect(screen.queryByText('em sintonia')).not.toBeInTheDocument();
  });

  it('only the host can remove a member, never themselves', () => {
    useStore.setState({ clientId: 'a' });
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    const { rerender } = render(<ListenersStage roomId="r" running={false} />);
    expect(screen.queryByLabelText('Remover Bob da sala')).not.toBeInTheDocument();

    rerender(<ListenersStage roomId="r" running={false} canModerate />);
    expect(screen.getByLabelText('Remover Bob da sala')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remover Alice da sala')).not.toBeInTheDocument();
  });

  it('puts "em sintonia" over this client\'s own avatar', () => {
    useStore.setState({ clientId: 'b' });
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    render(<ListenersStage roomId="r" running />);
    const label = screen.getByText('em sintonia');
    expect(label.closest('.r4-ls__member')).toHaveTextContent('Bob');
  });

  it('hides report and remove controls in the read-only preview', () => {
    useStore.setState({ clientId: 'a' });
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    render(<ListenersStage roomId="r" running={false} canModerate readOnly />);
    expect(screen.queryByLabelText('Denunciar Bob')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remover Bob da sala')).not.toBeInTheDocument();
  });

  describe('the arcs beat', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
          observe() {
            this.cb([{ isIntersecting: true }]);
          }
          disconnect() {}
        },
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    // Regression: the beat effect ran once on mount, found no row (no members
    // yet) and never started, so the arcs stayed still after joining a room.
    it('starts once members arrive after the stage mounted, while playing', async () => {
      useStore.getState().setMembers([]);
      const { container } = render(<ListenersStage roomId="r" running />);
      expect(container).toBeEmptyDOMElement();

      act(() => useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]));
      const row = container.querySelector<HTMLElement>('.r4-ls')!;
      await waitFor(() => expect(row.style.getPropertyValue('--b0')).not.toBe(''));
    });
  });

  describe('kick feedback (#390)', () => {
    beforeEach(() => {
      vi.mocked(kickMember).mockReset();
      useStore.setState({ clientId: 'a' });
      useStore.getState().setMembers([m('a', 'Alice'), { ...m('b', 'Bob'), clientIds: ['b', 'b2'] }]);
    });

    it('shows an alert to the host when every kick call fails', async () => {
      const err = new Error('only the host can do this');
      vi.mocked(kickMember).mockRejectedValue(err);
      render(<ListenersStage roomId="r" running={false} canModerate />);

      fireEvent.click(screen.getByLabelText('Remover Bob da sala'));

      expect(await screen.findByRole('alert')).toHaveTextContent(rpcErrorMessage(err, 'Não foi possível remover da sala.'));
      expect(kickMember).toHaveBeenCalledTimes(2);
    });

    it('stays quiet when one connection is kicked and a ghost one is not', async () => {
      vi.mocked(kickMember)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('not in this room'));
      render(<ListenersStage roomId="r" running={false} canModerate />);

      fireEvent.click(screen.getByLabelText('Remover Bob da sala'));

      await waitFor(() => expect(kickMember).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('role menu', () => {
    const withUsers = () => {
      useStore.setState({ clientId: 'a' });
      useStore.getState().setMembers([
        { ...m('a', 'Alice'), userId: 'ua' },
        { ...m('b', 'Bob'), userId: 'ub' },
        { ...m('c', 'Cris'), userId: 'uc' },
      ]);
    };

    it('uses the presence identity, not the stored anonymous id, for the owner button', async () => {
      withUsers(); // I am connection a, server identity ua
      const { rerender } = render(<ListenersStage roomId="r" running={false} ownerUserId="ua" hostUserId="ub" />);
      fireEvent.click(screen.getByRole('button', { name: 'Retomar anfitrião' }));
      await waitFor(() => expect(claimHost).toHaveBeenCalledWith('r'));
      rerender(<ListenersStage roomId="r" running={false} ownerUserId="ua" hostUserId="ua" />);
      expect(screen.queryByRole('button', { name: 'Retomar anfitrião' })).not.toBeInTheDocument();
      rerender(<ListenersStage roomId="r" running={false} ownerUserId="ub" hostUserId="uc" />);
      expect(screen.queryByRole('button', { name: 'Retomar anfitrião' })).not.toBeInTheDocument();
    });

    it('shows an admin chip next to admins only', () => {
      withUsers();
      render(<ListenersStage roomId="r" running={false} admins={['ub']} />);
      expect(screen.getAllByText('admin')).toHaveLength(1);
    });

    it('is hidden from non-moderators and from the owner target', () => {
      withUsers();
      const { rerender } = render(<ListenersStage roomId="r" running={false} admins={[]} />);
      expect(screen.queryByLabelText('Papéis de Bob')).not.toBeInTheDocument();
      rerender(<ListenersStage roomId="r" running={false} canModerate ownerUserId="ub" />);
      expect(screen.queryByLabelText('Papéis de Bob')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Remover Bob da sala')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Papéis de Cris')).toBeInTheDocument();
    });

    it('grants and revokes admin through the RPC', async () => {
      withUsers();
      const { rerender } = render(<ListenersStage roomId="r" running={false} canModerate admins={[]} />);
      fireEvent.click(screen.getByLabelText('Papéis de Bob'));
      fireEvent.click(screen.getByRole('button', { name: 'Tornar admin' }));
      await waitFor(() => expect(setRoomAdmin).toHaveBeenCalledWith('r', 'ub', true));

      rerender(<ListenersStage roomId="r" running={false} canModerate admins={['ub']} />);
      fireEvent.click(screen.getByLabelText('Papéis de Bob'));
      fireEvent.click(screen.getByRole('button', { name: 'Remover admin' }));
      await waitFor(() => expect(setRoomAdmin).toHaveBeenCalledWith('r', 'ub', false));
    });

    it('confirms by name before passing the host role', async () => {
      withUsers();
      render(<ListenersStage roomId="r" running={false} canModerate hostUserId="ua" />);
      fireEvent.click(screen.getByLabelText('Papéis de Cris'));
      fireEvent.click(screen.getByRole('button', { name: 'Passar anfitrião' }));
      expect(screen.getByRole('dialog')).toHaveTextContent('Passar o anfitrião para Cris?');
      expect(transferHost).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Passar anfitrião' }));
      await waitFor(() => expect(transferHost).toHaveBeenCalledWith('r', 'uc'));
    });
  });
});
