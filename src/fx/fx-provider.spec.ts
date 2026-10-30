import fc from 'fast-check';
import { convert } from '../common/money/money';
import { FIATS, usdRatesSchema, type UsdRates } from './fx-provider';
import { rateMatrix } from './rates';

const VALID: UsdRates = { USD: '1', NGN: '1500', GHS: '15', XAF: '600', EUR: '0.92' };

describe('usdRatesSchema', () => {
  it('accepts a realistic table', () => {
    expect(usdRatesSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    ['USD is not 1', { ...VALID, USD: '1.01' }],
    ['a rate is zero', { ...VALID, NGN: '0' }],
    ['a rate is below the lower bound', { ...VALID, NGN: '0.0001' }],
    ['a rate is above the upper bound', { ...VALID, NGN: '10000001' }],
    ['a rate string is absurdly long', { ...VALID, NGN: `1${'0'.repeat(40)}` }],
    ['a rate is not a plain decimal', { ...VALID, EUR: '1e3' }],
    ['a rate is text', { ...VALID, EUR: 'abc' }],
    ['a rate is an empty string', { ...VALID, EUR: '' }],
    ['a rate is a negative string', { ...VALID, EUR: '-1' }],
    ['USD is text', { ...VALID, USD: 'one' }],
    ['a rate is a number', { ...VALID, EUR: 0.92 }],
    ['a fiat is missing', { USD: '1', NGN: '1500', GHS: '15', XAF: '600' }],
    ['an unknown fiat is present', { ...VALID, JPY: '150' }],
  ])('rejects a table where %s', (_label, table) => {
    expect(usdRatesSchema.safeParse(table).success).toBe(false);
  });

  it('accepts the extremes of the allowed range', () => {
    expect(usdRatesSchema.safeParse({ ...VALID, NGN: '10000000', EUR: '0.001' }).success).toBe(
      true,
    );
  });

  it('only admits tables whose 20 cross rates all fit the conversion contract', () => {
    const rate = fc
      .tuple(fc.integer({ min: 0, max: 9_999_999 }), fc.integer({ min: 0, max: 999_999 }))
      .map(([whole, fraction]) => `${whole}.${fraction.toString().padStart(6, '0')}`);

    fc.assert(
      fc.property(fc.tuple(rate, rate, rate, rate), ([ngn, ghs, xaf, eur]) => {
        const table = { USD: '1', NGN: ngn, GHS: ghs, XAF: xaf, EUR: eur };
        fc.pre(usdRatesSchema.safeParse(table).success);

        for (const pair of rateMatrix(table)) {
          expect(pair.rate).toMatch(/^[0-9]{1,13}\.[0-9]{12}$/);
          expect(pair.rate).not.toBe('0.000000000000');
          expect(() => convert(1_000_000n, pair.rate)).not.toThrow();
        }
      }),
      { numRuns: 300 },
    );
  });

  it('covers every supported fiat', () => {
    expect([...FIATS].sort()).toEqual(['EUR', 'GHS', 'NGN', 'USD', 'XAF']);
  });
});
