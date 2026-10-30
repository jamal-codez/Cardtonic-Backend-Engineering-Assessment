import { AppError } from '../common/errors/app-error';
import { parseIdempotencyKey } from './idempotency-key';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('parseIdempotencyKey', () => {
  it.each(['a', 'k-1_2.3~x', '!'.repeat(255)])('accepts %j', (key) => {
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it.each([undefined, ''])('requires a key (%j)', (value) => {
    expect(errorCode(() => parseIdempotencyKey(value))).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it.each(['has space', 'tab\there', 'café', 'a'.repeat(256), 'two, values'])(
    'rejects %j as invalid',
    (value) => {
      expect(errorCode(() => parseIdempotencyKey(value))).toBe('IDEMPOTENCY_KEY_INVALID');
    },
  );

  it('rejects a non-string header value as invalid', () => {
    expect(errorCode(() => parseIdempotencyKey(['a', 'b']))).toBe('IDEMPOTENCY_KEY_INVALID');
  });
});
