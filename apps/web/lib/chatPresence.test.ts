import { describe, expect, it } from 'vitest';
import { groupPresence, isPresenceLine } from './chatPresence';

const sys = (id: string, text: string) => ({ id, kind: 'system', text });
const msg = (id: string, text: string) => ({ id, kind: 'user', text });

describe('groupPresence', () => {
  it('knows join, leave and share notices, in Portuguese or the old English', () => {
    expect(isPresenceLine('luk entrou')).toBe(true);
    expect(isPresenceLine('luk left')).toBe(true);
    expect(isPresenceLine('luk começou a compartilhar a tela')).toBe(true);
    expect(isPresenceLine('luk parou de compartilhar a tela')).toBe(true);
    expect(isPresenceLine('Tocando agora: Song, de Band')).toBe(false);
  });

  it('collapses a run of three or more notices and keeps shorter runs as they are', () => {
    const chat = [
      sys('1', 'luk entrou'),
      sys('2', 'luk saiu'),
      msg('3', 'oi'),
      sys('4', 'luk entrou'),
      sys('5', 'luk começou a compartilhar a tela'),
      sys('6', 'jay entrou'),
      sys('7', 'Tocando agora: Song'),
    ];
    const items = groupPresence(chat);
    expect(items.map((i) => (i.kind === 'run' ? `run:${i.msgs.length}` : i.msg.id))).toEqual([
      '1',
      '2',
      '3',
      'run:3',
      '7',
    ]);
    expect(items[3]).toMatchObject({ kind: 'run', id: '4' });
  });

  it('never collapses chat messages, even ones that end like a notice', () => {
    const items = groupPresence([msg('1', 'ele entrou'), msg('2', 'ele saiu'), msg('3', 'ele entrou')]);
    expect(items.every((i) => i.kind === 'one')).toBe(true);
  });
});
