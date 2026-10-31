import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/** The OpenAPI document served at /docs and written by `yarn openapi:export`. */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Operation Borderless API')
    .setDescription(
      'Multi-currency stablecoin wallet sandbox. Errors are application/problem+json with a stable `code`. Any route can also return NOT_FOUND (404), METHOD_NOT_ALLOWED (405), PAYLOAD_TOO_LARGE (413), RETRY_LATER (503, with Retry-After) or INTERNAL_ERROR (500). Amounts are strings with 6 decimals; timestamps are ISO 8601 UTC.',
    )
    .setVersion('0.1.0')
    .build();
  return SwaggerModule.createDocument(app, config);
}
