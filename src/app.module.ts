import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClockModule } from './common/clock/clock.module';
import { ConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/db/database.module';
import { RequestTimeoutInterceptor } from './common/http/request-timeout.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, LoggingModule, ClockModule, DatabaseModule, HealthModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor }],
})
export class AppModule {}
