// The mechanical half of ui/CLAUDE.md § Coding standards.
import tseslint from 'typescript-eslint';
import ui from './eslint/ui-rules.mjs';

export default [
  {
    files: ['ui/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { '@typescript-eslint': tseslint.plugin, ui },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'ui/element-tag': 'error',
      'ui/inline-style': 'error',
    },
  },
];
