import { describe, it, expect } from 'vitest';
import { computeNameSuffixes, applyNameSuffix, memberLabel } from './nameSuffix';

const m = (clientId: string, name: string) => ({ clientId, name });

describe('computeNameSuffixes', () => {
  it('assigns "" and " (2)" to two members sharing a name, by sorted clientId', () => {
    const suffixes = computeNameSuffixes([m('b', 'Alice'), m('a', 'Alice')]);
    expect(suffixes).toEqual({ a: '', b: ' (2)' });
  });

  it('numbers three collisions "", " (2)", " (3)"', () => {
    const suffixes = computeNameSuffixes([m('c', 'Alice'), m('a', 'Alice'), m('b', 'Alice')]);
    expect(suffixes).toEqual({ a: '', b: ' (2)', c: ' (3)' });
  });

  it('gives unique names no suffix', () => {
    const suffixes = computeNameSuffixes([m('a', 'Alice'), m('b', 'Bob')]);
    expect(suffixes).toEqual({ a: '', b: '' });
  });

  it('is deterministic: repeated calls on the same input produce identical output', () => {
    const members = [m('x', 'Ana'), m('y', 'Ana'), m('z', 'Bo')];
    expect(computeNameSuffixes(members)).toEqual(computeNameSuffixes(members));
  });

  it('adding an unrelated member leaves existing suffixes untouched', () => {
    const before = computeNameSuffixes([m('a', 'Alice'), m('b', 'Alice')]);
    const after = computeNameSuffixes([m('a', 'Alice'), m('b', 'Alice'), m('c', 'Carol')]);
    expect(after.a).toBe(before.a);
    expect(after.b).toBe(before.b);
    expect(after.c).toBe('');
  });

  it('renumbers deterministically when a same-named member joins with an earlier-sorting id', () => {
    const before = computeNameSuffixes([m('b', 'Alice'), m('c', 'Alice')]);
    expect(before).toEqual({ b: '', c: ' (2)' });
    // Newcomer "a" sorts first: the previous holder of "" renumbers to " (2)".
    // Renumbering is asserted, not just tolerated (spec: deterministic, not stable).
    const after = computeNameSuffixes([m('b', 'Alice'), m('c', 'Alice'), m('a', 'Alice')]);
    expect(after).toEqual({ a: '', b: ' (2)', c: ' (3)' });
  });

  it('renumbers those sorted after a middle member that leaves', () => {
    const after = computeNameSuffixes([m('a', 'Alice'), m('c', 'Alice')]);
    expect(after).toEqual({ a: '', c: ' (2)' });
  });
});

describe('applyNameSuffix', () => {
  it('returns the bare name when the suffix is empty', () => {
    expect(applyNameSuffix('Alice', '')).toBe('Alice');
  });

  it('composes name + suffix otherwise', () => {
    expect(applyNameSuffix('Alice', ' (2)')).toBe('Alice (2)');
  });
});

describe('memberLabel', () => {
  it('returns the bare name for a member without a suffix entry', () => {
    expect(memberLabel(m('a', 'Alice'), {})).toBe('Alice');
  });

  it('composes the member label from the suffix map', () => {
    const suffixes = computeNameSuffixes([m('a', 'Alice'), m('b', 'Alice')]);
    expect(memberLabel(m('a', 'Alice'), suffixes)).toBe('Alice');
    expect(memberLabel(m('b', 'Alice'), suffixes)).toBe('Alice (2)');
  });
});
