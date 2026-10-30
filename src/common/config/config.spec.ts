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

  it('defaults FX_PROVIDER to simulated and accepts only simulated or static', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).FX_PROVIDER).toBe('simulated');
    expect(loadConfig({ DATABASE_URL: 'x', FX_PROVIDER: 'static' }).FX_PROVIDER).toBe('static');
    for (const value of ['live', 'cached', '']) {
      expect(() => loadConfig({ DATABASE_URL: 'x', FX_PROVIDER: value })).toThrow(ConfigError);
    }
  });

  it('refreshes the rates every 0.9 minutes (54 seconds) by default', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).FX_REFRESH_INTERVAL_MS).toBe(54_000);
  });

  it('has sensible simulated-feed defaults: small steps, medium steps, a band, a move limit', () => {
    expect(loadConfig({ DATABASE_URL: 'x' })).toMatchObject({
      FX_SIM_SMALL_STEP_PCT: 0.3,
      FX_SIM_MEDIUM_STEP_PCT: 1.5,
      FX_SIM_BAND_PCT: 30,
      FX_MAX_MOVE_PCT: 20,
    });
  });

  it('rejects settings that would make the feed fail its own validation', () => {
    const base = { DATABASE_URL: 'x' };
    // a medium step bigger than the move limit would be rejected on arrival
    expect(() => loadConfig({ ...base, FX_SIM_MEDIUM_STEP_PCT: '25' })).toThrow(/FX_MAX_MOVE_PCT/);
    // a small step bigger than the medium one makes no sense
    expect(() => loadConfig({ ...base, FX_SIM_SMALL_STEP_PCT: '2' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, FX_SIM_BAND_PCT: '1' })).toThrow(/FX_SIM_BAND_PCT/);
    expect(() => loadConfig({ ...base, FX_SIM_BAND_PCT: '0' })).toThrow(ConfigError);
    expect(
      loadConfig({ ...base, FX_SIM_MEDIUM_STEP_PCT: '25', FX_MAX_MOVE_PCT: '30' })
        .FX_SIM_MEDIUM_STEP_PCT,
    ).toBe(25);
  });

  it('parses SCHEDULERS_ENABLED=false as a boolean', () => {
    expect(loadConfig({ DATABASE_URL: 'x', SCHEDULERS_ENABLED: 'false' }).SCHEDULERS_ENABLED).toBe(
      false,
    );
  });
});
