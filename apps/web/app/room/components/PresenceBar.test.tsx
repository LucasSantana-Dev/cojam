import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PresenceBar } from './PresenceBar';
import { useStore, type Member } from '@/lib/realtime';

const m = (clientId: string, name: string, platform?: Member['platform']): Member => ({
  clientId,
  name,
  ...(platform ? { platform } : {}),
});

describe('PresenceBar', () => {
  beforeEach(() => {
    useStore.getState().setMembers([]);
  });

  it('disambiguates two members sharing a name by sorted clientId', () => {
    useStore.getState().setMembers([m('b', 'Alice'), m('a', 'Alice')]);
    render(<PresenceBar roomId="r" />);

    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
  });

  it('renders a unique name with no suffix', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Bob')]);
    render(<PresenceBar roomId="r" />);

    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Bob')).toBeInTheDocument();
    expect(screen.queryByTitle(/\(2\)/)).not.toBeInTheDocument();
  });

  it('keeps suffixes stable when an unrelated member joins', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<PresenceBar roomId="r" />);
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();

    act(() => useStore.getState().addMember(m('c', 'Carol')));
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
    expect(screen.getByTitle('Carol')).toBeInTheDocument();
  });

  it('reverts to a bare name after the collision resolves', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<PresenceBar roomId="r" />);
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();

    act(() => useStore.getState().removeMember('b'));
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.queryByTitle('Alice (2)')).not.toBeInTheDocument();
  });

  it('does not dedupe by name: two same-named members render two chips and count twice', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<PresenceBar roomId="r" />);

    expect(screen.getByText('2 listening')).toBeInTheDocument();
  });

  it('"+N" overflow counts connections, not unique names', () => {
    // 8 connections, two of them the same name: 6 visible, +2 hidden.
    useStore.getState().setMembers([
      m('1', 'Alice'), m('2', 'Alice'), m('3', 'Bo'), m('4', 'Cy'),
      m('5', 'Di'), m('6', 'Ed'), m('7', 'Fi'), m('8', 'Gus'),
    ]);
    render(<PresenceBar roomId="r" />);

    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('8 listening')).toBeInTheDocument();
    // Both Alices are inside the visible 6 — no dedupe collapsed them.
    expect(screen.getByTitle('Alice')).toBeInTheDocument();
    expect(screen.getByTitle('Alice (2)')).toBeInTheDocument();
  });

  it('renders the platform indicator from presence data, and none when unreported', () => {
    useStore.getState().setMembers([m('a', 'Alice', 'spotify'), m('b', 'Bob')]);
    render(<PresenceBar roomId="r" />);

    expect(screen.getByTitle('spotify')).toBeInTheDocument();
    expect(screen.queryByTitle('apple')).not.toBeInTheDocument();
    expect(screen.queryByTitle('youtube')).not.toBeInTheDocument();
  });
});
