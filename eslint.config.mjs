import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // images/** is in-container code (CommonJS, its own package.json + Node
    // runtime), not part of the monorepo's TS lint scope.
    ignores: ['**/dist/**', '**/build/**', '**/.next/**', '**/node_modules/**', 'images/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Keep ESLint out of formatting's lane — Prettier owns that.
  prettier,
);
