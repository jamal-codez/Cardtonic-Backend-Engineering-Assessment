import { AppError } from '../errors/app-error';

export const CURRENCIES = {
  cNGN: { fiat: 'NGN', scale: 6 },
  cGHS: { fiat: 'GHS', scale: 6 },
  cXAF: { fiat: 'XAF', scale: 6 },
  USDx: { fiat: 'USD', scale: 6 },
  EURx: { fiat: 'EUR', scale: 6 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

const BY_LOWERCASE = new Map<string, CurrencyCode>(
  CURRENCY_CODES.map((code) => [code.toLowerCase(), code]),
);

/** Case-insensitive; returns the canonical spelling or throws UNSUPPORTED_CURRENCY. */
export function parseCurrency(input: unknown): CurrencyCode {
  if (typeof input === 'string') {
    const code = BY_LOWERCASE.get(input.toLowerCase());
    if (code) return code;
  }
  throw new AppError('UNSUPPORTED_CURRENCY', {
    detail: `Unsupported currency. Supported: ${CURRENCY_CODES.join(', ')}`,
  });
}
