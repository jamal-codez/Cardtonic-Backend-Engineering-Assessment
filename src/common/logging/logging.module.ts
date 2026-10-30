import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { resolveRequestId } from './request-id';

export const REDACT_PATHS = [
  'email',
  'phone',
  'err.detail',
  'err.cause.detail',
  'req.body.email',
  'req.body.phone',
  '*.email',
  '*.phone',
  '*.*.email',
  '*.*.phone',
  'req.headers.authorization',
  'req.headers.cookie',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false,
          },
          level: config.NODE_ENV === 'test' ? 'silent' : 'info',
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const existing = (req as { id?: unknown }).id;
            if (typeof existing === 'string') return existing;
            const id = resolveRequestId(req.headers['x-request-id']);
            res.setHeader('X-Request-Id', id);
            return id;
          },
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          customProps: (req: IncomingMessage) => ({ request_id: (req as { id?: unknown }).id }),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
