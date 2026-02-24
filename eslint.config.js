import { FlatCompat } from '@eslint/compat';
import eslintParserTypeScript from '@typescript-eslint/parser';
import globals from 'globals';

const compat = new FlatCompat({
  baseDirectory: import.meta.url ? new URL('.', import.meta.url).pathname : process.cwd(),
});

export default [
  ...compat.extends(
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier'
  ),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: eslintParserTypeScript,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // Add any specific rules here
      // Example: '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
];
