import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import type { CurrencyCode } from '../../common/money/currency';
import { convert } from '../../common/money/money';
import { RateService, type RateQuote } from '../../fx/rate.service';

/** Everything a posting needs to record and execute one conversion. */
export interface ConversionQuote {
  from: CurrencyCode;
  to: CurrencyCode;
  sourceMinor: bigint;
  destMinor: bigint;
  /** Exactly 12 decimals: the string that was used and is recorded. */
  rate: string;
  rateSource: RateQuote['source'];
  rateAsOf: Date;
}

/**
 * Prices a conversion from the current rate snapshot. It is synchronous and in-memory, and callers
 * use it before they open a database transaction (CLAUDE.md invariant 7). Shared by swaps and,
 * later, cross-currency transfers.
 */
@Injectable()
export class ConversionService {
  constructor(private readonly rates: RateService) {}

  /**
   * dest = floor(source x rate) on the exact 12-decimal rate that is recorded. A destination of
   * zero is rejected: the customer would give up money and receive nothing.
   */
  quoteForExecution(from: CurrencyCode, to: CurrencyCode, sourceMinor: bigint): ConversionQuote {
    if (from === to) {
      // Same-currency movements never involve FX: they must not be routed through here.
      throw new AppError('INTERNAL_ERROR', {
        detail: 'A same-currency movement must not be priced through the rate service',
      });
    }
    const { rate, source, asOf } = this.rates.getRate(from, to);
    const destMinor = convert(sourceMinor, rate);
    if (destMinor === 0n) {
      throw new AppError('AMOUNT_TOO_SMALL', {
        detail: 'The amount is too small to convert: it would receive nothing',
      });
    }
    return { from, to, sourceMinor, destMinor, rate, rateSource: source, rateAsOf: asOf };
  }
}
