import { ERROR_CATALOGUE, type ErrorCode, type FieldError } from './error-catalogue';

export interface AppErrorOptions {
  detail?: string;
  errors?: FieldError[];
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string;
  readonly errors?: FieldError[];
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const { status, title } = ERROR_CATALOGUE[code];
    super(
      options.detail ?? title,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = options.detail ?? title;
    this.errors = options.errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
