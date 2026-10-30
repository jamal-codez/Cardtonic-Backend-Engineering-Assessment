import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClockModule } from './common/clock/clock.module';
import { ConfigModule } from './common/config/config.module';
import { DatabaseModule } from './common/db/database.module';
import { RequestTimeoutInterceptor } from './common/http/request-timeout.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ClockModule,
    DatabaseModule,
    LedgerModule,
    IdempotencyModule,
    WalletsModule,
    PaymentsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor }],
})
export class AppModule {}
