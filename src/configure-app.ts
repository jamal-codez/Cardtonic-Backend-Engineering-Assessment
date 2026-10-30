import { ValidationError, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { bigintReplacer } from './common/json/bigint-replacer';
import { AppError } from './common/errors/app-error';
import type { FieldError } from './common/errors/error-catalogue';
import { ProblemJsonFilter } from './common/errors/problem-json.filter';
import { requestIdMiddleware } from './common/logging/request-id';

export const JSON_BODY_LIMIT = '10kb';

function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/** Shared by main.ts and the integration test app so tests exercise the production wiring. */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(requestIdMiddleware);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.set('json replacer', bigintReplacer);
  // CORS is off: enableCors() is never called.

  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalFilters(new ProblemJsonFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
      exceptionFactory: (errors) =>
        new AppError('VALIDATION_ERROR', {
          detail: 'Request validation failed',
          errors: flattenValidationErrors(errors),
        }),
    }),
  );
  app.enableShutdownHooks();
}

export function setupSwagger(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Operation Borderless API')
    .setDescription('Multi-currency stablecoin wallet sandbox')
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'Idempotency-Key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
