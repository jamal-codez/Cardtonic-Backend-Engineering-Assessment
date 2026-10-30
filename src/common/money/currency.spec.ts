import { AppError } from '../errors/app-error';
import { parseCurrency } from './currency';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('parseCurrency', () => {
  it.each([
    ['cngn', 'cNGN'],
    ['CNGN', 'cNGN'],
    ['usdx', 'USDx'],
    ['EURX', 'EURx'],
    ['cGhS', 'cGHS'],
    ['cxaf', 'cXAF'],
  ])('returns the canonical code for %s', (input, expected) => {
    expect(parseCurrency(input)).toBe(expected);
  });

  it.each(['XYZ', '', ' cNGN', 'NGN', 'USD'])('rejects %j as UNSUPPORTED_CURRENCY', (input) => {
    expect(errorCode(() => parseCurrency(input))).toBe('UNSUPPORTED_CURRENCY');
  });

  it('rejects non-string input', () => {
    expect(errorCode(() => parseCurrency(5))).toBe('UNSUPPORTED_CURRENCY');
    expect(errorCode(() => parseCurrency(undefined))).toBe('UNSUPPORTED_CURRENCY');
  });
});
