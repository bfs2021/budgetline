// `npm run lint`. Size limits: 300 lines per file, 50 per function (tests exempt), and
// a complexity cap. Dev dependencies: eslint, @eslint/js, typescript-eslint.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.claude/', 'dist/', 'build/', 'coverage/', 'node_modules/', '**/migrations/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'max-lines': ['error', { max: 300 }],
      'max-lines-per-function': ['error', { max: 50 }],
      complexity: ['error', 10],
    },
  },
  { files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**'], rules: { 'max-lines-per-function': 'off' } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
);
