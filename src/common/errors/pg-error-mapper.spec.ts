import { AppError } from './app-error';
import { mapPgError } from './pg-error-mapper';

const pgError = (code: string) => Object.assign(new Error('pg'), { code });

describe('mapPgError', () => {
  it('maps a unique violation to the context-specific 409', () => {
    const mapped = mapPgError(pgError('23505'), { uniqueViolation: 'WALLET_ALREADY_EXISTS' });
    expect(mapped).toBeInstanceOf(AppError);
    expect((mapped as AppError).status).toBe(409);
  });

  it('maps numeric out of range to AMOUNT_LIMIT_EXCEEDED', () => {
    expect((mapPgError(pgError('22003')) as AppError).code).toBe('AMOUNT_LIMIT_EXCEEDED');
  });

  it.each(['40P01', '40001', '55P03', '57014'])('maps %s to RETRY_LATER', (code) => {
    expect((mapPgError(pgError(code)) as AppError).code).toBe('RETRY_LATER');
  });

  it('defaults a check violation to INTERNAL_ERROR and leaves unknown errors alone', () => {
    expect((mapPgError(pgError('23514')) as AppError).code).toBe('INTERNAL_ERROR');
    const other = pgError('XX000');
    expect(mapPgError(other)).toBe(other);
  });
});
