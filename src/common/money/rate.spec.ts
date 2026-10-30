import fc from 'fast-check';
import { AppError } from '../errors/app-error';
import { ratio12dp } from './rate';

describe('ratio12dp', () => {
  it('prints exactly 12 decimals', () => {
    expect(ratio12dp('15', '1500')).toBe('0.010000000000');
    expect(ratio12dp('1', '1')).toBe('1.000000000000');
    expect(ratio12dp('1500', '15')).toBe('100.000000000000');
  });

  it('rounds down, never up', () => {
    expect(ratio12dp('1', '3')).toBe('0.333333333333');
    expect(ratio12dp('2', '3')).toBe('0.666666666666');
    expect(ratio12dp('0.92', '1500')).toBe('0.000613333333');
  });

  it('rejects non-decimal input and a zero denominator', () => {
    for (const bad of [
      ['1e3', '1'],
      ['-1', '1'],
      ['1', 'x'],
      ['', '1'],
    ] as const) {
      expect(() => ratio12dp(bad[0], bad[1])).toThrow(AppError);
    }
    expect(() => ratio12dp('1', '0')).toThrow(AppError);
  });

  it('never exceeds the exact quotient and is within 1e-12 of it', () => {
    const positive = fc.bigInt({ min: 1n, max: 10n ** 9n });
    fc.assert(
      fc.property(positive, positive, (n, d) => {
        const rate = ratio12dp(n.toString(), d.toString());
        const scaled = BigInt(rate.replace('.', ''));
        // rate = scaled / 1e12 <= n / d  <=>  scaled * d <= n * 1e12
        expect(scaled * d <= n * 10n ** 12n).toBe(true);
        expect((scaled + 1n) * d > n * 10n ** 12n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
