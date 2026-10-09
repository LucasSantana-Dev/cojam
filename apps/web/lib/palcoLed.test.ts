import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LED_GLYPHS, ledLayout, ledNormalize, ledPath, ledWidth } from './palcoLed';

// The font exists twice on purpose: in compose.py (baked into the share card) and here
// (drawn live in the DOM). They must stay the same glyphs.
describe('palco LED font', () => {
  const py = readFileSync(path.resolve(__dirname, '../scripts/palco-scenes/compose.py'), 'utf8');
  const font = py.split('\n').find((l) => l.startsWith('FONT = '))!;
  const rows = [...font.matchAll(/'(.)': \[([^\]]*)\]/g)].map(([, ch, body]) => [ch, [...body.matchAll(/'([01]+)'/g)].map((m) => m[1])] as const);

  it('matches compose.py glyph for glyph', () => {
    expect(rows.length).toBe(Object.keys(LED_GLYPHS).length);
    for (const [ch, g] of rows) expect(LED_GLYPHS[ch]).toEqual(g);
  });

  it('measures like compose.py text_w', () => {
    // 'COJAM' at k=3: five 5-wide glyphs, four 1px gaps plus the trailing one removed.
    expect(ledWidth('COJAM', 3)).toBe((5 * 6 - 1) * 3);
    expect(ledWidth('SALA', 2)).toBe((4 * 6 - 1) * 2);
  });

  it('strips accents, upper-cases and drops what the font lacks', () => {
    expect(ledNormalize('Conexão')).toBe('CONEXAO');
    expect(ledNormalize('a-b')).toBe('A B');
  });
});

describe('ledLayout', () => {
  it('centres a title and a sub line on the screen as the boards do', () => {
    const l = ledLayout(131, 74, { title: 'AO VIVO', scale: 2, sub: 'SALAS ABERTAS' });
    expect(l.title.k).toBe(2);
    expect(l.title.y).toBe(Math.floor((74 - 14 - 12) / 2));
    expect(l.title.x).toBe(Math.floor((131 - ledWidth('AO VIVO', 2)) / 2));
    expect(l.sub?.y).toBe(l.title.y + 14 + 6);
    expect(l.subTone).toBe('violet');
  });

  it('steps the scale down until the title fits', () => {
    // PRIVACIDADE is 65 wide at 1x, so 2x (130) does not fit a 131 screen with its margin.
    expect(ledLayout(131, 74, { title: 'PRIVACIDADE', scale: 2 }).title.k).toBe(1);
    expect(ledLayout(131, 74, { title: 'TERMOS', scale: 2 }).title.k).toBe(2);
  });

  it('keeps a long room code inside the screen', () => {
    const l = ledLayout(120, 70, { title: 'SALA', sub: 'UMA SALA COM UM NOME MUITO LONGO MESMO' });
    expect(l.sub).toBeDefined();
    expect(ledWidth(l.sub!.text)).toBeLessThanOrEqual(120 - 8);
    expect(l.sub!.text.endsWith('.')).toBe(true);
  });

  it('draws only whole-pixel squares', () => {
    const d = ledPath(ledLayout(131, 74, { title: 'A', scale: 2 }).title);
    expect(d).toMatch(/^M\d+ \d+h2v2h-2z/);
    expect(d).not.toMatch(/\./);
  });
});
