import { AppError } from '../common/errors/app-error';
import { normalizeEmail, normalizePhone } from './identity';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('normalizeEmail', () => {
  it('trims whitespace but keeps case, dots and +tags', () => {
    expect(normalizeEmail('  Ada.Lovelace+tag@Example.com ')).toBe('Ada.Lovelace+tag@Example.com');
  });

  it.each(['', 'nope', 'a@', '@b.com', 'a b@c.com'])('rejects %j', (value) => {
    expect(errorCode(() => normalizeEmail(value))).toBe('VALIDATION_ERROR');
  });
});

describe('normalizePhone', () => {
  it('defaults to Nigeria and returns E.164', () => {
    expect(normalizePhone('08031234567')).toBe('+2348031234567');
    expect(normalizePhone(' 0803 123 4567 ')).toBe('+2348031234567');
  });

  it('keeps an explicit international number', () => {
    expect(normalizePhone('+233201234567')).toBe('+233201234567');
  });

  it.each(['', 'abc', '123', '+999'])('rejects %j', (value) => {
    expect(errorCode(() => normalizePhone(value))).toBe('VALIDATION_ERROR');
  });
});
