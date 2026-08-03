import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceBar } from './PresenceBar';
import { PresenceMeta } from './PresenceMeta';
import { useStore, type Member } from '@/lib/realtime';

const m = (clientId: string, name: string): Member => ({ clientId, name });

// Shared fixture: PresenceBar and the fused chip must agree on every label.
const FIXTURE: Member[] = [m('a', 'Alice'), m('b', 'Alice'), m('c', 'Bob')];

describe('PresenceMeta (fused now-playing chip)', () => {
  beforeEach(() => {
    useStore.getState().setMembers([]);
  });

  it('renders the same labels as PresenceBar for the same member list', () => {
    useStore.getState().setMembers(FIXTURE);
    const bar = render(<PresenceBar />);
    const barTitles = Array.from(bar.container.querySelectorAll('[title]'))
      .map((el) => el.getAttribute('title'))
      .sort();
    bar.unmount();

    const meta = render(<PresenceMeta />);
    const metaTitles = Array.from(meta.container.querySelectorAll('[title]'))
      .map((el) => el.getAttribute('title'))
      .sort();

    expect(metaTitles).toEqual(barTitles);
    expect(metaTitles).toEqual(['Alice', 'Alice (2)', 'Bob']);
  });

  it('counts connections, not unique names', () => {
    useStore.getState().setMembers([m('a', 'Alice'), m('b', 'Alice')]);
    render(<PresenceMeta />);

    expect(screen.getByText('2 listening')).toBeInTheDocument();
  });

  it('renders nothing when the room is empty', () => {
    const { container } = render(<PresenceMeta />);
    expect(container).toBeEmptyDOMElement();
  });
});
