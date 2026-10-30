import { ConfigError, loadConfig } from './config';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is provided', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config).toMatchObject({
      PORT: 3000,
      DB_POOL_MAX: 10,
      SCHEDULERS_ENABLED: true,
      REQUEST_TIMEOUT_MS: 10_000,
    });
  });

  it('fails fast with a readable message when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it.each(['4999', '86400001', 'abc'])('rejects FX_REFRESH_INTERVAL_MS=%s', (value) => {
    expect(() => loadConfig({ DATABASE_URL: 'x', FX_REFRESH_INTERVAL_MS: value })).toThrow(
      ConfigError,
    );
  });

  it('defaults FX_PROVIDER to static and accepts only static or live', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).FX_PROVIDER).toBe('static');
    expect(() => loadConfig({ DATABASE_URL: 'x', FX_PROVIDER: 'cached' })).toThrow(ConfigError);
  });

  it('parses SCHEDULERS_ENABLED=false as a boolean', () => {
    expect(loadConfig({ DATABASE_URL: 'x', SCHEDULERS_ENABLED: 'false' }).SCHEDULERS_ENABLED).toBe(
      false,
    );
  });
});
