import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

// Matches the rule set the removed `next lint` applied by default
// (core-web-vitals). The stricter eslint-config-next/typescript preset
// currently reports ~90 pre-existing errors; adopt it separately if wanted.
export default defineConfig([
  ...nextVitals,
  {
    rules: {
      // New in the react-hooks v6 preset bundled with eslint-config-next 16;
      // 15 pre-existing violations (setState in effects, ref access patterns).
      // Kept visible as warnings; tighten to error after a dedicated cleanup.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts']),
]);
