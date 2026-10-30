import { AppError } from '../errors/app-error';
import { RateDecimal } from './decimal';

export const RATE_DECIMALS = 12;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
const DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

/**
 * numerator / denominator, rounded DOWN to 12 decimals and returned as an exact 12-decimal
 * string. That string is what gets recorded and what `convert` multiplies by.
 *
 * Built with bigint scaling rather than a number formatter, so there is no float anywhere.
 * Flooring at 40 digits and then at 12 decimals equals a single floor at 12 decimals.
 */
export function ratio12dp(numerator: string, denominator: string): string {
  if (!DECIMAL_PATTERN.test(numerator) || !DECIMAL_PATTERN.test(denominator)) {
    throw new AppError('INTERNAL_ERROR', { detail: 'rate inputs must be plain decimal strings' });
  }
  const divisor = new RateDecimal(denominator);
  if (divisor.isZero()) {
    throw new AppError('INTERNAL_ERROR', { detail: 'rate denominator must not be zero' });
  }
  const scaled = BigInt(
    new RateDecimal(numerator).div(divisor).times(RATE_SCALE.toString()).floor().toString(),
  );
  const whole = scaled / RATE_SCALE;
  const fraction = (scaled % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0');
  return `${whole.toString()}.${fraction}`;
}
