import { z } from 'zod';
import { RateDecimal } from '../common/money/decimal';
import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from '../common/money/currency';

export type Fiat = (typeof CURRENCIES)[CurrencyCode]['fiat'];

export const FIATS = CURRENCY_CODES.map<Fiat>((code) => CURRENCIES[code].fiat);

/** Units of each fiat per 1 USD. USD is always "1". */
export type UsdRates = Record<Fiat, string>;

/** Where a rate table came from. `simulated` is the random-walk feed; `static` is the fixed file. */
export type FxSource = 'simulated' | 'static';

export interface FxRates {
  /**
   * Whatever the provider produced, unchecked: RateService validates it (all five fiats, finite,
   * positive, within bounds, no wild jump) before it is stored or used.
   */
  rates: Record<string, unknown>;
  providerUpdatedAt: Date;
}

/** A source of USD-based rates. Only `RateService` knows about providers. */
export interface FxProvider {
  readonly name: FxSource;
  /**
   * `previous` is the last accepted table. A feed that moves step by step starts from it, so it
   * holds no state of its own: a rejected or failed step cannot leave it ahead of what is stored.
   */
  fetchUsdRates(previous?: UsdRates): Promise<FxRates>;
}

export const FX_PROVIDER = Symbol('FX_PROVIDER');

// A table is only usable if every one of the 20 cross rates fits convert()'s 12-decimal,
// 13-digit contract and is not zero after rounding. Bounding each fiat keeps all ratios safe.
const MIN_USD_RATE = new RateDecimal('0.001');
const MAX_USD_RATE = new RateDecimal('10000000');

const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

// Every Decimal conversion below is guarded by PLAIN_DECIMAL: `new Decimal('abc')` throws, and a
// bad value must be reported as a validation issue, never crash the check.
const positiveDecimal = z
  .string()
  .max(32)
  .regex(PLAIN_DECIMAL, 'must be a plain decimal string')
  .refine(
    (value) => PLAIN_DECIMAL.test(value) && new RateDecimal(value).gt(0),
    'must be greater than zero',
  );

/** Shape check shared by the static file, stored snapshots and whatever a provider produces. */
export const usdRatesSchema = z
  .object(
    Object.fromEntries(FIATS.map((fiat) => [fiat, positiveDecimal])) as Record<
      Fiat,
      typeof positiveDecimal
    >,
  )
  .strict()
  .refine((rates) => PLAIN_DECIMAL.test(rates.USD) && new RateDecimal(rates.USD).eq(1), {
    message: 'USD must be exactly 1',
  })
  .superRefine((rates, ctx) => {
    for (const fiat of FIATS) {
      if (!PLAIN_DECIMAL.test(rates[fiat])) continue; // already reported above
      const value = new RateDecimal(rates[fiat]);
      if (value.lt(MIN_USD_RATE) || value.gt(MAX_USD_RATE)) {
        ctx.addIssue({
          code: 'custom',
          path: [fiat],
          message: 'must be between 0.001 and 10000000 per 1 USD',
        });
      }
    }
  });
