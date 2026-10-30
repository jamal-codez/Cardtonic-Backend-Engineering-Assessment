import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

const moneyMessage = 'money must use bigint/Decimal helpers';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', '.yarn', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: moneyMessage },
        { name: 'parseInt', message: moneyMessage },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: moneyMessage },
        { object: 'Number', property: 'parseInt', message: moneyMessage },
        { property: 'toFixed', message: moneyMessage },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number'], NewExpression[callee.name='Number']",
          message: moneyMessage,
        },
      ],
    },
  },
);
