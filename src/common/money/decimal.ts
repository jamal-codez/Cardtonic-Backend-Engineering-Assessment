import Decimal from 'decimal.js';

/**
 * Local Decimal clone for rates: 40 significant digits, always rounding down, and plain
 * (never exponent) string output so results convert cleanly to bigint.
 */
export const RateDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_DOWN,
  toExpPos: 40,
  toExpNeg: -40,
});
