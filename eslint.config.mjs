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
        { object: 'Date', property: 'now', message: 'use the injected Clock' },
        { property: 'toFixed', message: moneyMessage },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number'], NewExpression[callee.name='Number']",
          message: moneyMessage,
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'use the injected Clock instead of new Date()',
        },
      ],
    },
  },
  {
    // Supertest response bodies are untyped (`any`); asserting on them is the point of the tests.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Only RateService is public: everything outside fx/ may import fx/rate.service and fx/fx.module.
    files: ['src/**/*.ts'],
    ignores: ['src/fx/**', 'src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/fx/**', '!**/fx/rate.service', '!**/fx/fx.module'],
              message: 'only fx/rate.service and fx/fx.module may be imported from outside fx',
            },
          ],
        },
      ],
    },
  },
  {
    // Deposits and same-currency transfers never touch the FX module (declared after the block
    // above so this stricter rule wins for these files).
    files: ['src/payments/deposits/**/*.ts', 'src/idempotency/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/fx', '**/fx/**'],
              message: 'deposits must never import the fx module',
            },
          ],
        },
      ],
    },
  },
  {
    // The clock is the one place allowed to read the system time.
    files: ['src/common/clock/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
