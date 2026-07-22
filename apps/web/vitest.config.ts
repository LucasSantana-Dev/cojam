import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    // jsdom globally so component render tests need no per-file docblock; the
    // pure-logic suites are environment-agnostic and pass under either.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
});
