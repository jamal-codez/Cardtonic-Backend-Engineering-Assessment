import { AppError } from '../errors/app-error';
import { RateDecimal } from './decimal';

export const SCALE = 6;
export const MINOR_PER_UNIT = 1_000_000n;
/** Default per-transaction cap, in whole units. Overridden by the MAX_TX_AMOUNT setting. */
export const DEFAULT_MAX_TX_AMOUNT = 1_000_000_000n;

/** Largest value a Postgres bigint column can hold. */
const MAX_BIGINT = 2n ** 63n - 1n;

const AMOUNT_PATTERN = /^[0-9]+(\.[0-9]{1,6})?$/;
const RATE_PATTERN = /^[0-9]{1,13}\.[0-9]{12}$/;

/**
 * Parses an API amount string into minor units. Only plain decimal strings are accepted:
 * no JSON numbers, signs, exponents, hex or whitespace.
 */
export function parseAmount(input: unknown, maxUnits: bigint = DEFAULT_MAX_TX_AMOUNT): bigint {
  if (typeof input !== 'string' || !AMOUNT_PATTERN.test(input)) {
    throw new AppError('VALIDATION_ERROR', {
      detail: 'amount must be a decimal string with at most 6 decimal places',
    });
  }
  const [whole = '0', fraction = ''] = input.split('.');
  const minor = BigInt(whole) * MINOR_PER_UNIT + BigInt(fraction.padEnd(SCALE, '0'));
  if (minor <= 0n) {
    throw new AppError('VALIDATION_ERROR', { detail: 'amount must be greater than zero' });
  }
  if (minor > maxUnits * MINOR_PER_UNIT) {
    throw new AppError('AMOUNT_LIMIT_EXCEEDED', {
      detail: `amount exceeds the limit of ${maxUnits.toString()} units`,
    });
  }
  return minor;
}

/** Always 6 decimals, computed on bigint only (never through a JS number). */
export function formatAmount(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / MINOR_PER_UNIT;
  const fraction = (abs % MINOR_PER_UNIT).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Two decimals, rounded down (toward zero), for display of USD totals. */
export function formatUsd2dp(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const cents = abs / 10_000n;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${negative && cents > 0n ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * floor(sourceMinor x rate), where `rate` is the exact 12-decimal string that gets recorded.
 * A result of 0 is returned as 0n; callers reject it with AMOUNT_TOO_SMALL.
 */
export function convert(sourceMinor: bigint, rate: string): bigint {
  if (sourceMinor < 0n) {
    throw new AppError('INTERNAL_ERROR', { detail: 'convert expects a non-negative amount' });
  }
  if (!RATE_PATTERN.test(rate)) {
    throw new AppError('INTERNAL_ERROR', { detail: 'rate must be a 12 decimal string' });
  }
  const product = new RateDecimal(sourceMinor.toString()).times(rate).floor();
  const result = BigInt(product.toString());
  if (result > MAX_BIGINT) {
    throw new AppError('AMOUNT_LIMIT_EXCEEDED', { detail: 'converted amount is too large' });
  }
  return result;
}
