import fc from 'fast-check';
import { AppError } from '../errors/app-error';
import { convert, formatAmount, formatUsd2dp, parseAmount } from './money';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
};

describe('parseAmount', () => {
  it.each([
    ['1', 1_000_000n],
    ['0.000001', 1n],
    ['1000000000', 1_000_000_000_000_000n],
    ['12.5', 12_500_000n],
    ['007', 7_000_000n],
  ])('accepts %j', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([
    '0',
    '0.000000',
    '-1',
    '+1',
    '1e3',
    '0x10',
    ' 5',
    '5 ',
    '.5',
    '5.',
    '1.0000001',
    '',
    '5\n',
    '٣',
  ])('rejects %j with VALIDATION_ERROR', (input) => {
    expect(codeOf(() => parseAmount(input))).toBe('VALIDATION_ERROR');
  });

  it('rejects a number type, never coercing it', () => {
    expect(codeOf(() => parseAmount(5))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => parseAmount(null))).toBe('VALIDATION_ERROR');
  });

  it('rejects an amount above the limit with AMOUNT_LIMIT_EXCEEDED', () => {
    expect(codeOf(() => parseAmount('1000000000.000001'))).toBe('AMOUNT_LIMIT_EXCEEDED');
    expect(codeOf(() => parseAmount('1000000001'))).toBe('AMOUNT_LIMIT_EXCEEDED');
  });

  it('honours a custom limit', () => {
    expect(parseAmount('10', 10n)).toBe(10_000_000n);
    expect(codeOf(() => parseAmount('10.000001', 10n))).toBe('AMOUNT_LIMIT_EXCEEDED');
  });
});

describe('formatAmount', () => {
  it('always prints 6 decimals', () => {
    expect(formatAmount(0n)).toBe('0.000000');
    expect(formatAmount(1n)).toBe('0.000001');
    expect(formatAmount(1_000_000n)).toBe('1.000000');
    expect(formatAmount(1_000_000_000_000_000n)).toBe('1000000000.000000');
  });

  it('handles values far beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    expect(formatAmount(123_456_789_012_345_678_901n)).toBe('123456789012345.678901');
  });

  it('round-trips with parseAmount for any valid amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000_000_000n }), (minor) => {
        expect(parseAmount(formatAmount(minor))).toBe(minor);
      }),
    );
  });
});

describe('formatUsd2dp', () => {
  it('rounds down to 2 decimals', () => {
    expect(formatUsd2dp(0n)).toBe('0.00');
    expect(formatUsd2dp(9_999n)).toBe('0.00');
    expect(formatUsd2dp(10_000n)).toBe('0.01');
    expect(formatUsd2dp(1_999_999n)).toBe('1.99');
    expect(formatUsd2dp(1_234_567_890_000n)).toBe('1234567.89');
  });
});

describe('convert', () => {
  it('floors the product', () => {
    expect(convert(1_000_000n, '1500.000000000000')).toBe(1_500_000_000n);
    expect(convert(3n, '0.333333333333')).toBe(0n);
    expect(convert(10n, '0.999999999999')).toBe(9n);
    expect(convert(1n, '1.000000000000')).toBe(1n);
  });

  it('rejects a result that would overflow a bigint column', () => {
    expect(codeOf(() => convert(1_000_000_000_000_000n, '9999999999999.999999999999'))).toBe(
      'AMOUNT_LIMIT_EXCEEDED',
    );
  });

  it('rejects a rate that is not a 12 decimal string', () => {
    expect(codeOf(() => convert(1n, '1.5'))).toBe('INTERNAL_ERROR');
    expect(codeOf(() => convert(1n, '1e3'))).toBe('INTERNAL_ERROR');
  });

  it('rounds down and never exceeds the exact product', () => {
    const rate = fc
      .tuple(fc.bigInt({ min: 0n, max: 9_000n }), fc.bigInt({ min: 0n, max: 999_999_999_999n }))
      .map(([whole, frac]) => `${whole.toString()}.${frac.toString().padStart(12, '0')}`);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000_000_000n }), rate, (source, r) => {
        const rateScaled = BigInt(r.replace('.', ''));
        const exact = source * rateScaled;
        const out = convert(source, r);
        expect(out * 10n ** 12n <= exact).toBe(true);
        expect(out * 10n ** 12n > exact - 10n ** 12n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
