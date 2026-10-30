import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../common/clock/clock';
import { loadStaticRates, STATIC_RATES_PATH, StaticFxProvider } from './static-fx-provider';

describe('static FX rates', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'static-rates-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };
  const valid = { USD: '1', NGN: '1500', GHS: '15', XAF: '600', EUR: '0.92' };
  const loadedAt = new Date('2026-03-03T12:00:00.000Z');

  it('loads the shipped file, labelled as illustrative, with USD = 1', async () => {
    const provider = new StaticFxProvider(new FakeClock(loadedAt));
    const result = await provider.fetchUsdRates();
    expect(provider.name).toBe('static');
    expect(result.rates.USD).toBe('1');
    expect(result.providerUpdatedAt).toEqual(loadedAt);
    expect(Object.keys(result.rates).sort()).toEqual(['EUR', 'GHS', 'NGN', 'USD', 'XAF']);
    expect(readFileSync(STATIC_RATES_PATH, 'utf8').toLowerCase()).toContain('illustrative');
  });

  it('stamps providerUpdatedAt with the time the file was loaded', () => {
    expect(loadStaticRates(write('ok.json', { rates: valid }), loadedAt).providerUpdatedAt).toBe(
      loadedAt,
    );
  });

  it.each([
    ['USD not 1', { rates: { ...valid, USD: '2' } }],
    ['a fiat is missing', { rates: { USD: '1', NGN: '1500', GHS: '15', XAF: '600' } }],
    ['a rate is zero', { rates: { ...valid, NGN: '0' } }],
    ['a rate is not a plain decimal', { rates: { ...valid, NGN: '1e3' } }],
    ['a rate is a number', { rates: { ...valid, NGN: 1500 } }],
    ['an unknown fiat is present', { rates: { ...valid, JPY: '150' } }],
    ['there is no rates key', {}],
  ])('rejects a file where %s', (_label, content) => {
    expect(() => loadStaticRates(write('bad.json', content), loadedAt)).toThrow(
      /Invalid static FX rates/,
    );
  });

  it('rejects a missing or malformed file with a readable error', () => {
    expect(() => loadStaticRates(join(dir, 'missing.json'), loadedAt)).toThrow(
      /Cannot read static FX rates/,
    );
    expect(() => loadStaticRates(write('junk.json', '{nope'), loadedAt)).toThrow(
      /Cannot read static FX rates/,
    );
  });
});
