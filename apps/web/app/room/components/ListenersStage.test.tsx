import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ListenersStage } from './ListenersStage';
import { useStore, type Member } from '@/lib/realtime';

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

    expect(screen.getByLabelText('2 ouvindo')).toBeInTheDocument();
  });

  it('"+N" overflow counts connections, not unique names', () => {
    // 8 connections, two of them the same name: 6 visible, +2 hidden.
    useStore.getState().setMembers([
      m('1', 'Alice'), m('2', 'Alice'), m('3', 'Bo'), m('4', 'Cy'),
      m('5', 'Di'), m('6', 'Ed'), m('7', 'Fi'), m('8', 'Gus'),
    ]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByLabelText('8 ouvindo')).toBeInTheDocument();
    // Both Alices are inside the visible 6 — no dedupe collapsed them.
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
  });

  it('renders the platform indicator from presence data, and none when unreported', () => {
    useStore.getState().setMembers([m('a', 'Alice', 'spotify'), m('b', 'Bob')]);
    render(<ListenersStage roomId="r" running={false} />);

    expect(screen.getByTitle('Spotify')).toHaveAttribute('data-svc', 'spotify');
    expect(screen.queryByTitle('Apple Music')).not.toBeInTheDocument();
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
      { clientId: 'b', userId: 'u2', name: 'Dani', platform: 'apple' },
    ]);
    render(<ListenersStage roomId="r" running={false} hostUserId="u1" />);

    expect(screen.getByText('(Spotify)')).toBeInTheDocument();
    expect(screen.getByText('(Apple Music)')).toBeInTheDocument();
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

    rerender(<ListenersStage roomId="r" running={false} canControl />);
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
    render(<ListenersStage roomId="r" running={false} canControl readOnly />);
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
});
