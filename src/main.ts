import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigError, loadConfig, type AppConfig } from './common/config/config';
import { configureApp, setupSwagger } from './configure-app';

async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  setupSwagger(app);
  await app.listen(config.PORT);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
