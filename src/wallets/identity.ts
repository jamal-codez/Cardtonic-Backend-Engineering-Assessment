import { isEmail } from 'class-validator';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { AppError } from '../common/errors/app-error';

export const DEFAULT_PHONE_REGION = 'NG';

/**
 * Trims and validates an email. Comparison is case-insensitive in the database (citext).
 * `+tags` and dots are deliberately kept: they can identify different mailboxes.
 */
export function normalizeEmail(input: string): string {
  const email = input.trim();
  if (!isEmail(email)) {
    throw new AppError('VALIDATION_ERROR', {
      detail: 'email is invalid',
      errors: [{ field: 'email', message: 'must be an email' }],
    });
  }
  return email;
}

/** Parses with region NG as the default and returns E.164. */
export function normalizePhone(input: string): string {
  const parsed = parsePhoneNumberFromString(input.trim(), DEFAULT_PHONE_REGION);
  if (!parsed?.isValid()) {
    throw new AppError('VALIDATION_ERROR', {
      detail: 'phone is invalid',
      errors: [{ field: 'phone', message: 'must be a valid phone number' }],
    });
  }
  return parsed.number;
}
