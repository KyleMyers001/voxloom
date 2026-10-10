import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': ['error', 'always'],
    },
  },
  {
    ignores: [
      '.cargo-local/**',
      '.playwright-browsers',
      '.target-cpal17/**',
      'dist',
      'playwright-report',
      'playwright-report-release',
      'src-tauri/target',
      'test-results',
      'test-results-release',
    ],
  },
);
