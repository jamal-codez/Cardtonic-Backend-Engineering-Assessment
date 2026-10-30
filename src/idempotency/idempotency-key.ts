import { AppError } from '../common/errors/app-error';

const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/** Reads the `Idempotency-Key` header value. Required on every money-moving endpoint. */
export function parseIdempotencyKey(header: unknown): string {
  if (header === undefined || header === '') {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', {
      detail: 'Send an Idempotency-Key header (1 to 255 printable ASCII characters, no spaces)',
    });
  }
  if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
    throw new AppError('IDEMPOTENCY_KEY_INVALID', {
      detail: 'Idempotency-Key must be 1 to 255 printable ASCII characters without spaces',
    });
  }
  return header;
}
