import type { UsdRates } from './fx-provider';
import { validateSnapshot } from './snapshot-validation';

const PREVIOUS: UsdRates = { USD: '1', NGN: '1500', GHS: '15', XAF: '600', EUR: '0.92' };

const reasonOf = (verdict: ReturnType<typeof validateSnapshot>): string =>
  verdict.ok ? 'ACCEPTED' : verdict.reason;

describe('validateSnapshot', () => {
  it('accepts a sound table, as strings or as JSON numbers', () => {
    expect(validateSnapshot({ ...PREVIOUS }, PREVIOUS, 20)).toEqual({ ok: true, rates: PREVIOUS });
    const fromNumbers = validateSnapshot(
      { USD: 1, NGN: 1346.223823, GHS: 11.658068, XAF: 587.687873, EUR: 0.895934 },
      null,
      20,
    );
    expect(fromNumbers).toEqual({
      ok: true,
      rates: { USD: '1', NGN: '1346.223823', GHS: '11.658068', XAF: '587.687873', EUR: '0.895934' },
    });
  });

  it.each([
    ['NGN', { USD: '1', GHS: '15', XAF: '600', EUR: '0.92' }],
    ['GHS', { USD: '1', NGN: '1500', XAF: '600', EUR: '0.92' }],
    ['XAF', { USD: '1', NGN: '1500', GHS: '15', EUR: '0.92' }],
    ['EUR', { USD: '1', NGN: '1500', GHS: '15', XAF: '600' }],
    ['USD', { NGN: '1500', GHS: '15', XAF: '600', EUR: '0.92' }],
  ])('rejects a table without %s', (fiat, raw) => {
    expect(reasonOf(validateSnapshot(raw, PREVIOUS, 20))).toBe(`${fiat} is missing`);
  });

  it('treats null and undefined values as missing', () => {
    expect(reasonOf(validateSnapshot({ ...PREVIOUS, XAF: null }, null, 20))).toBe('XAF is missing');
    expect(reasonOf(validateSnapshot({ ...PREVIOUS, XAF: undefined }, null, 20))).toBe(
      'XAF is missing',
    );
  });

  it.each([
    ['zero (number)', 0],
    ['zero (string)', '0'],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['text', 'abc'],
    ['an exponent string', '1e3'],
    ['an empty string', ''],
    ['an object', { rate: 1 }],
    ['a boolean', true],
    ['below the lower bound', 0.0001],
    ['above the upper bound', 99_999_999],
  ])('rejects NGN when it is %s', (_label, value) => {
    const verdict = validateSnapshot({ ...PREVIOUS, NGN: value }, null, 20);
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toMatch(/NGN/);
  });

  it('rejects a USD that is not exactly 1', () => {
    expect(reasonOf(validateSnapshot({ ...PREVIOUS, USD: '1.01' }, null, 20))).toMatch(/USD/);
  });

  describe('the move check against the previous snapshot', () => {
    it('rejects a jump above the limit and names the rate and the size', () => {
      const verdict = validateSnapshot({ ...PREVIOUS, NGN: '2250' }, PREVIOUS, 20);
      expect(reasonOf(verdict)).toBe('NGN moved 50% (limit 20%)');
    });

    it('rejects a fall just as it rejects a rise', () => {
      expect(reasonOf(validateSnapshot({ ...PREVIOUS, GHS: '10' }, PREVIOUS, 20))).toMatch(
        /GHS moved 33\.3%/,
      );
    });

    it('accepts a move of exactly the limit and rejects one tick beyond it', () => {
      expect(validateSnapshot({ ...PREVIOUS, NGN: '1800' }, PREVIOUS, 20).ok).toBe(true);
      expect(validateSnapshot({ ...PREVIOUS, NGN: '1800.000001' }, PREVIOUS, 20).ok).toBe(false);
    });

    it('is skipped when there is no previous snapshot, so a first table may differ a lot', () => {
      const wild = { USD: '1', NGN: '5000', GHS: '40', XAF: '900', EUR: '0.5' };
      expect(validateSnapshot(wild, null, 20).ok).toBe(true);
      expect(validateSnapshot(wild, PREVIOUS, 20).ok).toBe(false);
    });

    it('follows the configured limit', () => {
      expect(validateSnapshot({ ...PREVIOUS, NGN: '1800' }, PREVIOUS, 10).ok).toBe(false);
      expect(validateSnapshot({ ...PREVIOUS, NGN: '1800' }, PREVIOUS, 25).ok).toBe(true);
    });
  });
});
