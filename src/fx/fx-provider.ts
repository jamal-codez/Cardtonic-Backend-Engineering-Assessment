import { z } from 'zod';
import { RateDecimal } from '../common/money/decimal';
import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from '../common/money/currency';

export type Fiat = (typeof CURRENCIES)[CurrencyCode]['fiat'];

export const FIATS = CURRENCY_CODES.map<Fiat>((code) => CURRENCIES[code].fiat);

/** Units of each fiat per 1 USD. USD is always "1". */
export type UsdRates = Record<Fiat, string>;

export type FxSource = 'live' | 'static';

export interface FxRates {
  rates: UsdRates;
  providerUpdatedAt: Date;
}

/** A source of USD-based rates. Only `RateService` knows about providers. */
export interface FxProvider {
  readonly name: FxSource;
  fetchUsdRates(signal?: AbortSignal): Promise<FxRates>;
}

export const FX_PROVIDER = Symbol('FX_PROVIDER');

// A table is only usable if every one of the 20 cross rates fits convert()'s 12-decimal,
// 13-digit contract and is not zero after rounding. Bounding each fiat keeps all ratios safe.
const MIN_USD_RATE = new RateDecimal('0.001');
const MAX_USD_RATE = new RateDecimal('10000000');

const positiveDecimal = z
  .string()
  .max(32)
  .regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a plain decimal string')
  .refine((value) => new RateDecimal(value).gt(0), 'must be greater than zero');

/** Shape check shared by the static file, stored snapshots and (later) live responses. */
export const usdRatesSchema = z
  .object(
    Object.fromEntries(FIATS.map((fiat) => [fiat, positiveDecimal])) as Record<
      Fiat,
      typeof positiveDecimal
    >,
  )
  .strict()
  .refine((rates) => new RateDecimal(rates.USD).eq(1), { message: 'USD must be exactly 1' })
  .superRefine((rates, ctx) => {
    for (const fiat of FIATS) {
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
