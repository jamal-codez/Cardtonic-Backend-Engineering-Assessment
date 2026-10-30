import { AppError } from './app-error';
import type { ErrorCode } from './error-catalogue';

export const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set(['40P01', '40001', '55P03']);

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isRetryablePgError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

export interface PgErrorContext {
  /** The 409 that a unique violation (23505) becomes in this context. */
  uniqueViolation?: ErrorCode;
  /** What a check violation (23514) becomes in this context. Defaults to INTERNAL_ERROR. */
  checkViolation?: ErrorCode;
}

/** Maps a Postgres error to an AppError; returns the input unchanged when it is not mapped. */
export function mapPgError(error: unknown, context: PgErrorContext = {}): unknown {
  if (error instanceof AppError) return error;
  switch (pgErrorCode(error)) {
    case '23505':
      return new AppError(context.uniqueViolation ?? 'INTERNAL_ERROR', { cause: error });
    case '23514':
      return new AppError(context.checkViolation ?? 'INTERNAL_ERROR', { cause: error });
    case '22003':
      return new AppError('AMOUNT_LIMIT_EXCEEDED', { cause: error });
    case '40P01':
    case '40001':
    case '55P03':
    case '57014':
      return new AppError('RETRY_LATER', { retryAfterSeconds: 1, cause: error });
    default:
      return error;
  }
}
