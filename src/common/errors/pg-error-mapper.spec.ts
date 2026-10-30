import { AppError } from './app-error';
import { isRetryablePgError, mapPgError } from './pg-error-mapper';

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

  it('finds the SQLSTATE on the cause of a wrapped driver error (as Drizzle throws them)', () => {
    const wrapped = new Error('Failed query', { cause: pgError('23505') });
    const mapped = mapPgError(wrapped, { uniqueViolation: 'WALLET_ALREADY_EXISTS' });
    expect((mapped as AppError).code).toBe('WALLET_ALREADY_EXISTS');
    expect(isRetryablePgError(new Error('Failed query', { cause: pgError('40P01') }))).toBe(true);
  });

  it('defaults a check violation to INTERNAL_ERROR and leaves unknown errors alone', () => {
    expect((mapPgError(pgError('23514')) as AppError).code).toBe('INTERNAL_ERROR');
    const other = pgError('XX000');
    expect(mapPgError(other)).toBe(other);
  });
});
