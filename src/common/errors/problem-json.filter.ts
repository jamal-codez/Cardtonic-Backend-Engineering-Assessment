import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from './app-error';
import { mapPgError } from './pg-error-mapper';
import { ERROR_CATALOGUE, type ErrorCode, type FieldError } from './error-catalogue';

interface Problem {
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
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(error.message)
  );
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
        { err: exception, request_id: requestId, code: resolved.code },
        'Request failed',
      );
    }

    const slug = resolved.code.toLowerCase().replace(/_/g, '-');
    const body: Problem = {
      type: `urn:problem:${slug}`,
      title: ERROR_CATALOGUE[resolved.code].title,
      status: resolved.status,
      detail: resolved.detail,
      code: resolved.code,
      request_id: requestId,
      ...(resolved.errors ? { errors: resolved.errors } : {}),
    };

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
