import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CLOCK, FakeClock } from '../../src/common/clock/clock';
import { PG_POOL, TransactionRunner } from '../../src/common/db/database.module';
import { configureApp } from '../../src/configure-app';
import { RateService } from '../../src/fx/rate.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { resetDb } from './reset-db';

export interface TestApp {
  app: INestApplication;
  clock: FakeClock;
  agent: ReturnType<typeof request>;
  pool: Pool;
  ledger: LedgerService;
  rates: RateService;
  transactions: TransactionRunner;
  /** Truncates all tables except currencies, reseeds, clears the ledger's id cache and reloads FX rates. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Boots the real AppModule with a FakeClock and test config (pool max 30, schedulers off). */
export async function createTestApp(): Promise<TestApp> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is not set; did global setup run?');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DB_POOL_MAX: '30',
    SCHEDULERS_ENABLED: 'false',
  });

  const clock = new FakeClock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bufferLogs: true,
    bodyParser: false,
  });
  configureApp(app);
  await app.init();

  const pool = app.get<Pool>(PG_POOL);
  const ledger = app.get(LedgerService);
  const rates = app.get(RateService);

  return {
    app,
    clock,
    agent: request(app.getHttpServer()),
    pool,
    ledger,
    rates,
    transactions: app.get(TransactionRunner),
    reset: async () => {
      await resetDb(pool);
      ledger.clearSystemAccountCache();
      await rates.initialize();
    },
    close: () => app.close(),
  };
}
