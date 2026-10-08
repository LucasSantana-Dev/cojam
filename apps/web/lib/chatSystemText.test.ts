import { describe, expect, it } from 'vitest';
import { ptSystemText } from './chatSystemText';

describe('ptSystemText', () => {
  it('translates persisted English lines', () => {
    expect(ptSystemText('Luk joined')).toBe('Luk entrou');
    expect(ptSystemText('Luk left')).toBe('Luk saiu');
    expect(ptSystemText('Someone joined')).toBe('Alguém entrou');
    expect(ptSystemText('Now playing: Pétala \u2014 Djavan')).toBe('Tocando agora: Pétala, de Djavan');
  });
  it('splits at the last long dash and tolerates an empty artist', () => {
    expect(ptSystemText('Now playing: A \u2014 B \u2014 Cher')).toBe('Tocando agora: A \u2014 B, de Cher');
    expect(ptSystemText('Now playing: Pétala \u2014 ')).toBe('Tocando agora: Pétala');
  });
  it('never rewrites new Portuguese lines that end in left or joined', () => {
    expect(ptSystemText('Tocando agora: X, de Someone left')).toBe('Tocando agora: X, de Someone left');
  });
  it('keeps Portuguese lines as they are', () => {
    expect(ptSystemText('Luk entrou')).toBe('Luk entrou');
    expect(ptSystemText('Tocando agora: Pétala, de Djavan')).toBe('Tocando agora: Pétala, de Djavan');
  });
});
