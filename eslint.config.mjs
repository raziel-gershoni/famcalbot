import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // A leading underscore marks a parameter or binding that is unused on purpose.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // Build output and dependencies. dist/ is the local tsc output, never committed.
    ignores: ['.next/**', 'dist/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'],
  },
];

export default config;
