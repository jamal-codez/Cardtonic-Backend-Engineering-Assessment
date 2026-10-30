import fc from 'fast-check';
import { AppError } from '../../common/errors/app-error';
import type { RateService } from '../../fx/rate.service';
import { ConversionService } from './conversion.service';

const AS_OF = new Date('2026-01-01T00:00:00.000Z');

function serviceWithRate(rate: string) {
  const getRate = jest.fn<{ rate: string; source: 'static'; asOf: Date }, [string, string]>(() => ({
    rate,
    source: 'static',
    asOf: AS_OF,
  }));
  const service = new ConversionService({ getRate } as unknown as RateService);
  return { service, getRate };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('ConversionService.quoteForExecution', () => {
  it('prices dest = floor(source x rate) and returns everything the posting records', () => {
    const { service, getRate } = serviceWithRate('0.000666666666');

    const quote = service.quoteForExecution('cNGN', 'USDx', 1_500_000_000n);

    expect(getRate).toHaveBeenCalledWith('cNGN', 'USDx');
    expect(quote).toEqual({
      from: 'cNGN',
      to: 'USDx',
      sourceMinor: 1_500_000_000n,
      destMinor: 999_999n,
      rate: '0.000666666666',
      rateSource: 'static',
      rateAsOf: AS_OF,
    });
  });

  it('rejects an amount that would convert to nothing with AMOUNT_TOO_SMALL', () => {
    const { service } = serviceWithRate('0.000666666666');
    expect(errorCode(() => service.quoteForExecution('cNGN', 'USDx', 1n))).toBe('AMOUNT_TOO_SMALL');
    expect(errorCode(() => service.quoteForExecution('cNGN', 'USDx', 1_500n))).toBe(
      'AMOUNT_TOO_SMALL',
    );
  });

  it('accepts the smallest amount that converts to one minor unit', () => {
    const { service } = serviceWithRate('0.000666666666');
    expect(service.quoteForExecution('cNGN', 'USDx', 1_501n).destMinor).toBe(1n);
  });

  it('refuses a same-currency pair without ever touching the rate service', () => {
    const { service, getRate } = serviceWithRate('1.000000000000');
    expect(errorCode(() => service.quoteForExecution('cNGN', 'cNGN', 1_000_000n))).toBe(
      'INTERNAL_ERROR',
    );
    expect(getRate).not.toHaveBeenCalled();
  });

  it('lets a rate-service failure (FX unavailable) pass through unchanged', () => {
    const service = new ConversionService({
      getRate: () => {
        throw new AppError('FX_UNAVAILABLE');
      },
    } as unknown as RateService);
    expect(errorCode(() => service.quoteForExecution('cNGN', 'USDx', 1_000_000n))).toBe(
      'FX_UNAVAILABLE',
    );
  });

  it('never pays out more than the exact product and loses less than one minor unit', () => {
    const rate = fc
      .tuple(fc.integer({ min: 0, max: 99_999 }), fc.bigInt({ min: 0n, max: 999_999_999_999n }))
      .map(([whole, fraction]) => `${whole}.${fraction.toString().padStart(12, '0')}`);

    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), rate, (source, r) => {
        const { service } = serviceWithRate(r);
        let dest: bigint;
        try {
          dest = service.quoteForExecution('cNGN', 'USDx', source).destMinor;
        } catch (error) {
          // The only legitimate rejection is a destination that rounds to nothing.
          expect((error as AppError).code).toBe('AMOUNT_TOO_SMALL');
          const exactScaled = source * BigInt(r.replace('.', ''));
          expect(exactScaled < 10n ** 12n).toBe(true);
          return;
        }
        const exactScaled = source * BigInt(r.replace('.', '')); // exact product x 10^12
        expect(dest * 10n ** 12n <= exactScaled).toBe(true);
        expect(exactScaled - dest * 10n ** 12n < 10n ** 12n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
