import { Global, Inject, Logger, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { withTransaction, type Db, type TransactionOptions } from './with-transaction';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Injectable()
export class TransactionRunner {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  run<T>(fn: (tx: Db) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return withTransaction(this.pool, fn, options);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const pool = new Pool({
          connectionString: config.DATABASE_URL,
          max: config.DB_POOL_MAX,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
        });
        // Without a listener, an idle-connection reset (e.g. a Postgres restart) crashes the process.
        pool.on('error', (err) => new Logger('PgPool').error({ err }, 'Idle pg client error'));
        return pool;
      },
    },
    { provide: DRIZZLE, inject: [PG_POOL], useFactory: (pool: Pool): Db => drizzle(pool) },
    PoolLifecycle,
    TransactionRunner,
  ],
  exports: [PG_POOL, DRIZZLE, TransactionRunner],
})
export class DatabaseModule {}
