import { describe, it, expect, beforeEach } from 'vitest';
import { endedNotice, hasSharedBefore, markShared, viewerChangeNotice } from './screenShareNotices';

const names: Record<string, string> = { a: 'Ana', b: 'Bia' };
const nameOf = (id: string) => names[id] ?? 'Alguém';

describe('viewerChangeNotice', () => {
  it('names one viewer joining or leaving', () => {
    expect(viewerChangeNotice([], ['a'], nameOf)).toBe('Ana começou a assistir.');
    expect(viewerChangeNotice(['a', 'b'], ['a'], nameOf)).toBe('Bia parou de assistir.');
  });

  it('counts a burst instead of naming', () => {
    expect(viewerChangeNotice([], ['a', 'b'], nameOf)).toBe('Na sua transmissão: 2 entraram.');
    expect(viewerChangeNotice(['a'], ['b'], nameOf)).toBe('Na sua transmissão: 1 entrou e 1 saiu.');
  });

  it('is empty when nothing changed', () => {
    expect(viewerChangeNotice(['a'], ['a'], nameOf)).toBe('');
  });
});

describe('endedNotice', () => {
  it('says the broadcaster left when they are gone', () => {
    expect(endedNotice('Ana', false)).toBe('Ana saiu da sala e a transmissão terminou.');
    expect(endedNotice('Ana', true)).toBe('A transmissão terminou.');
  });
});

describe('shared before', () => {
  beforeEach(() => localStorage.clear());
  it('remembers the first share', () => {
    expect(hasSharedBefore()).toBe(false);
    markShared();
    expect(hasSharedBefore()).toBe(true);
  });
});
