import { describe, expect, it } from 'vitest';
import { ptSystemText } from './chatSystemText';

describe('ptSystemText', () => {
  it('translates persisted English lines', () => {
    expect(ptSystemText('Luk joined')).toBe('Luk entrou');
    expect(ptSystemText('Luk left')).toBe('Luk saiu');
    expect(ptSystemText('Someone joined')).toBe('Alguém entrou');
    expect(ptSystemText('Now playing: Pétala — Djavan')).toBe('Tocando agora: Pétala, de Djavan');
  });
  it('keeps Portuguese lines as they are', () => {
    expect(ptSystemText('Luk entrou')).toBe('Luk entrou');
    expect(ptSystemText('Tocando agora: Pétala, de Djavan')).toBe('Tocando agora: Pétala, de Djavan');
  });
});
