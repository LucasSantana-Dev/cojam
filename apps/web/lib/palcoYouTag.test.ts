import { describe, it, expect } from 'vitest';
import { youTagLabel, YOU_TAG_MAX } from './palcoYouTag';

describe('youTagLabel', () => {
  it('is just "Você" for an empty or blank name', () => {
    expect(youTagLabel('')).toBe('Você');
    expect(youTagLabel('   ')).toBe('Você');
  });

  it('shows the trimmed typed nickname', () => {
    expect(youTagLabel('  Lu  ')).toBe('Você · Lu');
  });

  it('keeps a name at the cap whole', () => {
    const name = 'a'.repeat(YOU_TAG_MAX);
    expect(youTagLabel(name)).toBe(`Você · ${name}`);
  });

  it('caps a long name with an ellipsis', () => {
    const out = youTagLabel('Maria Eduarda Albuquerque Souza');
    expect(out).toBe('Você · Maria Eduarda A…');
    expect(Array.from(out.replace('Você · ', '')).length).toBe(YOU_TAG_MAX);
  });
});
