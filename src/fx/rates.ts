import { CURRENCIES, CURRENCY_CODES, type CurrencyCode } from '../common/money/currency';
import { convert } from '../common/money/money';
import { ratio12dp } from '../common/money/rate';
import type { UsdRates } from './fx-provider';

/** The coin that is pegged 1:1 to USD; the pivot for every cross rate. */
export const USD_COIN: CurrencyCode = 'USDx';

export interface RatePair {
  from: CurrencyCode;
  to: CurrencyCode;
  rate: string;
}

/**
 * Units of `to` per 1 `from`: usd[toFiat] / usd[fromFiat], rounded down to 12 decimals. Every
 * cross rate pivots through USD, so there is one rate table and no triangular arbitrage.
 * An identity pair is exactly "1.000000000000".
 */
export function crossRate(usd: UsdRates, from: CurrencyCode, to: CurrencyCode): string {
  const fromFiat = CURRENCIES[from].fiat;
  const toFiat = CURRENCIES[to].fiat;
  if (fromFiat === toFiat) return ratio12dp('1', '1');
  return ratio12dp(usd[toFiat], usd[fromFiat]);
}

/** All ordered pairs except identity pairs, in registry order by from, then to. */
export function rateMatrix(usd: UsdRates): RatePair[] {
  return CURRENCY_CODES.flatMap((from) =>
    CURRENCY_CODES.filter((to) => to !== from).map((to) => ({
      from,
      to,
      rate: crossRate(usd, from, to),
    })),
  );
}

/**
 * Total value in USD minor units. Each balance is converted on its own with the recorded
 * 12-decimal rate and floored, so the total never overstates.
 */
export function usdValueMinor(
  usd: UsdRates,
  balances: { currency: CurrencyCode; balance: bigint }[],
): bigint {
  return balances.reduce(
    (total, { currency, balance }) => total + convert(balance, crossRate(usd, currency, USD_COIN)),
    0n,
  );
}
