import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { createOpenApiDocument } from '../src/docs/build-openapi';
import { buildPostmanCollection } from '../src/docs/postman';

/**
 * Writes openapi.json and the Postman collection without a database: the Nest application is
 * created (providers are instantiated, the pg pool is lazy) but never initialised, so no module
 * init hook runs and no connection is opened. DATABASE_URL only has to be present.
 */
async function main(): Promise<void> {
  process.env['DATABASE_URL'] ??= 'postgres://unused:unused@127.0.0.1:1/unused';
  process.env['SCHEDULERS_ENABLED'] = 'false';

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bodyParser: false,
  });
  configureApp(app);
  const document = createOpenApiDocument(app);

  const root = join(__dirname, '..');
  writeFileSync(join(root, 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(
    join(root, 'postman', 'borderless.postman_collection.json'),
    `${JSON.stringify(buildPostmanCollection(document), null, 2)}\n`,
  );
  // Not app.close(): the application was never initialised, so there is nothing to shut down.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
