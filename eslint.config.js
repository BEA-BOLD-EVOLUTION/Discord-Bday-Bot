import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      // Off: this codebase uses `let x = <fallback>; try { x = ... } catch {}`
      // throughout, and the rule's flow analysis flags the fallback init as
      // dead even though it's read on the catch path. False-positive-prone.
      'no-useless-assignment': 'off',
      // Floating promises are a common Discord.js footgun, but the core rule
      // can't detect them without type info; we rely on tsc --checkJs for that.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  // Disable stylistic rules that conflict with Prettier.
  prettier,
];
