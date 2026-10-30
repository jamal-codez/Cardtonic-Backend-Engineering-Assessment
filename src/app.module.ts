import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClockModule } from './common/clock/clock.module';
import { ConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/db/database.module';
import { RequestTimeoutInterceptor } from './common/http/request-timeout.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [ConfigModule, LoggingModule, ClockModule, DatabaseModule, LedgerModule, HealthModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor }],
})
export class AppModule {}
