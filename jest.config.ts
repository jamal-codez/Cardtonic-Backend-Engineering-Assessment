import type { Config } from 'jest';

const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
};

const config: Config = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      rootDir: '<rootDir>',
      roots: ['<rootDir>/src'],
      testMatch: ['**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'int',
      rootDir: '<rootDir>',
      roots: ['<rootDir>/test'],
      testMatch: ['**/*.int-spec.ts'],
      globalSetup: '<rootDir>/test/global-setup.ts',
      globalTeardown: '<rootDir>/test/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
    },
  ],
};

export default config;
