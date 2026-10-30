import fc from 'fast-check';
import { CURRENCY_CODES } from '../common/money/currency';
import { convert } from '../common/money/money';
import type { UsdRates } from './fx-provider';
import { crossRate, rateMatrix, usdValueMinor } from './rates';

const USD_RATES: UsdRates = { USD: '1', NGN: '1500', GHS: '15', XAF: '600', EUR: '0.92' };

describe('crossRate', () => {
  it('computes the cross rate through USD: cNGN to cGHS is 15/1500', () => {
    expect(crossRate(USD_RATES, 'cNGN', 'cGHS')).toBe('0.010000000000');
  });

  it('rounds the quotient down to 12 decimals', () => {
    // 0.92 / 1500 = 0.000613333333333...
    expect(crossRate(USD_RATES, 'cNGN', 'EURx')).toBe('0.000613333333');
    // 1 / 1500 = 0.000666666666666...
    expect(crossRate(USD_RATES, 'cNGN', 'USDx')).toBe('0.000666666666');
  });

  it('returns exactly 1 for an identity pair', () => {
    for (const code of CURRENCY_CODES) {
      expect(crossRate(USD_RATES, code, code)).toBe('1.000000000000');
    }
  });

  it('prices one USD in each fiat', () => {
    expect(crossRate(USD_RATES, 'USDx', 'cNGN')).toBe('1500.000000000000');
    expect(crossRate(USD_RATES, 'USDx', 'EURx')).toBe('0.920000000000');
  });
});

describe('rateMatrix', () => {
  const matrix = rateMatrix(USD_RATES);

  it('has 20 ordered pairs and none of them is an identity pair', () => {
    expect(matrix).toHaveLength(20);
    expect(matrix.filter((pair) => pair.from === pair.to)).toEqual([]);
    expect(new Set(matrix.map((pair) => `${pair.from}>${pair.to}`)).size).toBe(20);
  });

  it('is ordered by from, then to, in registry order', () => {
    expect(matrix.slice(0, 5).map((pair) => `${pair.from}>${pair.to}`)).toEqual([
      'cNGN>cGHS',
      'cNGN>cXAF',
      'cNGN>USDx',
      'cNGN>EURx',
      'cGHS>cNGN',
    ]);
  });

  it('prints every rate with exactly 12 decimals', () => {
    for (const pair of matrix) expect(pair.rate).toMatch(/^[0-9]+\.[0-9]{12}$/);
  });
});

describe('usdValueMinor', () => {
  it('contributes 0 for 1 minor unit of cNGN', () => {
    expect(usdValueMinor(USD_RATES, [{ currency: 'cNGN', balance: 1n }])).toBe(0n);
  });

  it('values USDx at par', () => {
    expect(usdValueMinor(USD_RATES, [{ currency: 'USDx', balance: 10_000_000n }])).toBe(
      10_000_000n,
    );
  });

  it('floors each balance on its own, so the total never overstates', () => {
    // 1500 cNGN is exactly 1 USD in theory, but the recorded rate is rounded down.
    const total = usdValueMinor(USD_RATES, [{ currency: 'cNGN', balance: 1_500_000_000n }]);
    expect(total).toBe(999_999n); // 0.999999 USD, not 1.000000
  });

  it('sums several balances', () => {
    const total = usdValueMinor(USD_RATES, [
      { currency: 'USDx', balance: 2_000_000n },
      { currency: 'cGHS', balance: 15_000_000n },
    ]);
    // 15 GHS at 1/15 floored to 12dp is 0.066666666666 per GHS -> 0.999999999990 USD.
    expect(total).toBe(2_000_000n + convert(15_000_000n, crossRate(USD_RATES, 'cGHS', 'USDx')));
  });
});

describe('conversion value safety', () => {
  const coin = fc.constantFrom(...CURRENCY_CODES);

  it('a round trip a -> b -> a never returns more than was put in', () => {
    fc.assert(
      fc.property(coin, coin, fc.bigInt({ min: 0n, max: 1_000_000_000_000n }), (a, b, amount) => {
        const there = convert(amount, crossRate(USD_RATES, a, b));
        const back = convert(there, crossRate(USD_RATES, b, a));
        expect(back <= amount).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
