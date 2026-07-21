import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // New in the react-hooks v6 preset bundled with eslint-config-next 16;
      // 15 pre-existing violations (setState in effects, ref access patterns).
      // Kept visible as warnings; tighten to error after a dedicated cleanup.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  {
    // Test mocks patch globals (localStorage, window, fetch) and stub partial
    // Response/Request shapes; typing those precisely costs more than it guards.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts']),
]);
