import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from './app-error';
import { mapPgError, pgErrorCode } from './pg-error-mapper';
import { ERROR_CATALOGUE, type ErrorCode, type FieldError } from './error-catalogue';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  request_id: string;
  errors?: FieldError[];
}

interface ResolvedError {
  code: ErrorCode;
  status: number;
  detail: string;
  errors?: FieldError[];
  retryAfterSeconds?: number;
}

/** RFC 9457 body for an error; also used to store a business rejection against an idempotency key. */
export function buildProblem(
  error: { code: ErrorCode; status: number; detail: string; errors?: FieldError[] },
  requestId: string,
): Problem {
  const slug = error.code.toLowerCase().replace(/_/g, '-');
  return {
    type: `urn:problem:${slug}`,
    title: ERROR_CATALOGUE[error.code].title,
    status: error.status,
    detail: error.detail,
    code: error.code,
    request_id: requestId,
    ...(error.errors ? { errors: error.errors } : {}),
  };
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
};

function isHttpLikeError(error: unknown): error is { status: number; message: string } {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Drizzle wraps driver errors; look at the original too.
  const messages = [error.message, error.cause instanceof Error ? error.cause.message : ''];
  const code = pgErrorCode(error);
  return (
    (code !== undefined && CONNECTION_ERROR_CODES.has(code)) ||
    messages.some((m) => /timeout exceeded when trying to connect|Connection terminated/i.test(m))
  );
}

/**
 * Drizzle's wrapper error carries the SQL text and bound parameters (which can hold an email or
 * phone) in its message, `query` and `params`. Log the underlying driver error instead, and only
 * its name, message, SQLSTATE and stack: never the `detail` field, which echoes row values.
 */
function safeErrorForLog(error: unknown): Record<string, unknown> {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!(current instanceof Error)) break;
    const isDriverWrapper = 'query' in current && 'params' in current;
    if (!isDriverWrapper) break;
    current = current.cause;
  }
  if (!(current instanceof Error)) return { message: 'non-error value thrown' };
  const code = pgErrorCode(current);
  return {
    name: current.name,
    message: current.message,
    ...(code ? { pgCode: code } : {}),
    stack: current.stack,
  };
}

@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemJsonFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: unknown }>();
    const res = http.getResponse<Response>();
    if (res.headersSent) return;

    const resolved = this.resolve(exception);
    const requestId =
      (typeof req.id === 'string' ? req.id : undefined) ??
      (res.getHeader('X-Request-Id') as string | undefined) ??
      'unknown';

    if (resolved.status >= 500) {
      this.logger.error(
        { err: safeErrorForLog(exception), request_id: requestId, code: resolved.code },
        'Request failed',
      );
    }

    const body = buildProblem(resolved, requestId);

    if (resolved.retryAfterSeconds !== undefined || resolved.status === 503) {
      res.setHeader('Retry-After', String(resolved.retryAfterSeconds ?? 1));
    }
    res.status(resolved.status).type('application/problem+json').send(JSON.stringify(body));
  }

  private resolve(raw: unknown): ResolvedError {
    const exception = isConnectionError(raw)
      ? new AppError('RETRY_LATER', { retryAfterSeconds: 1, cause: raw })
      : mapPgError(raw);
    if (exception instanceof AppError) {
      return {
        code: exception.code,
        status: exception.status,
        detail: exception.detail,
        errors: exception.errors,
        retryAfterSeconds: exception.retryAfterSeconds,
      };
    }
    if (exception instanceof HttpException) {
      return this.fromStatus(exception.getStatus(), exception.message);
    }
    // body-parser / http-errors (413, malformed JSON) are plain errors carrying a status.
    if (isHttpLikeError(exception)) {
      return this.fromStatus(exception.status, exception.message);
    }
    return {
      code: 'INTERNAL_ERROR',
      status: 500,
      detail: ERROR_CATALOGUE.INTERNAL_ERROR.title,
    };
  }

  private fromStatus(status: number, message: string): ResolvedError {
    if (status >= 500) {
      return { code: 'INTERNAL_ERROR', status: 500, detail: ERROR_CATALOGUE.INTERNAL_ERROR.title };
    }
    return { code: STATUS_TO_CODE[status] ?? 'VALIDATION_ERROR', status, detail: message };
  }
}
