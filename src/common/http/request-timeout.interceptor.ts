import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AppError } from '../errors/app-error';

/**
 * Answers 503 RETRY_LATER once REQUEST_TIMEOUT_MS elapses. The handler is not cancelled, so a
 * transaction may still commit after the client saw the 503. Money endpoints are idempotent, so
 * the client retries with the same key and gets the stored result.
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.config.REQUEST_TIMEOUT_MS),
      catchError((error: unknown) =>
        error instanceof TimeoutError
          ? throwError(() => new AppError('RETRY_LATER', { retryAfterSeconds: 1 }))
          : throwError(() => error),
      ),
    );
  }
}
