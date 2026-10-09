import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from './manifest';

const PUBLIC = path.resolve(__dirname, '../public');

describe('web app manifest', () => {
  const m = manifest();

  it('is an installable standalone PT-BR app rooted at /', () => {
    expect(m).toMatchObject({
      id: '/',
      name: 'CoJam',
      short_name: 'CoJam',
      lang: 'pt-BR',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#0d0a17',
      theme_color: '#0d0a17',
    });
    expect(m.description).toMatch(/CoJam/);
  });

  it('declares 192 and 512 any icons plus a 512 maskable, all present on disk', () => {
    const icons = m.icons ?? [];
    const find = (sizes: string, purpose: string) => icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(find('192x192', 'any')).toBeDefined();
    expect(find('512x512', 'any')).toBeDefined();
    expect(find('512x512', 'maskable')).toBeDefined();
    for (const icon of icons) {
      const file = path.join(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const buf = readFileSync(file);
      const [w] = (icon.sizes ?? '').split('x').map(Number);
      expect(buf.readUInt32BE(16), `${icon.src} width`).toBe(w);
      expect(buf.readUInt32BE(20), `${icon.src} height`).toBe(w);
    }
  });
});
