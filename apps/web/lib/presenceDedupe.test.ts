import { describe, it, expect, beforeEach } from 'vitest';
import { collapseMembers, useStore } from './realtime';

describe('one person = one listener', () => {
  beforeEach(() => useStore.getState().setMembers([]));

  it('collapses connections sharing a userId, keeping every clientId', () => {
    const out = collapseMembers([
      { clientId: 'c1', userId: 'u1', name: 'Luk' },
      { clientId: 'c2', userId: 'u2', name: 'Bia' },
      { clientId: 'c3', userId: 'u1', name: 'Luk', platform: 'spotify' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ clientId: 'c1', clientIds: ['c1', 'c3'], platform: 'spotify' });
  });

  it('is identical for any arrival order', () => {
    const a = [
      { clientId: 'c1', userId: 'u1', name: 'Luk' },
      { clientId: 'c3', userId: 'u1', name: 'Luk', platform: 'spotify' as const },
      { clientId: 'c2', userId: 'u2', name: 'Luk' },
    ];
    const b = [a[2], a[1], a[0]];
    expect(collapseMembers(b)).toEqual(collapseMembers(a));
    useStore.getState().setMembers(a);
    const s1 = useStore.getState().nameSuffixes;
    useStore.getState().setMembers(b);
    expect(useStore.getState().nameSuffixes).toEqual(s1);
  });

  it('keeps connections without a userId separate', () => {
    expect(collapseMembers([
      { clientId: 'a', name: 'X' },
      { clientId: 'b', name: 'X' },
    ])).toHaveLength(2);
  });

  it('store: rejoin with a new clientId is not a new person, no "(2)" suffix', () => {
    const s = useStore.getState();
    s.setMembers([{ clientId: 'c1', userId: 'u1', name: 'Luk' }]);
    useStore.getState().addMember({ clientId: 'c2', userId: 'u1', name: 'Luk' });
    expect(useStore.getState().members).toHaveLength(1);
    expect(Object.values(useStore.getState().nameSuffixes).every((v) => v === '')).toBe(true);
    useStore.getState().removeMember('c1');
    expect(useStore.getState().members).toHaveLength(1);
    expect(useStore.getState().members[0].clientIds).toEqual(['c2']);
    useStore.getState().removeMember('c2');
    expect(useStore.getState().members).toHaveLength(0);
  });
});
