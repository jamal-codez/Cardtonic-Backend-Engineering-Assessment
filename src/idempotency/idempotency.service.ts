import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { TransactionRunner } from '../common/db/database.module';
import { idempotencyKeys } from '../common/db/schema';
import type { Db } from '../common/db/with-transaction';
import { AppError } from '../common/errors/app-error';
import { mapPgError } from '../common/errors/pg-error-mapper';
import { buildProblem } from '../common/errors/problem-json.filter';

export interface WorkResult {
  statusCode: number;
  body: unknown;
  transactionId?: string;
}

export interface ExecuteResult {
  statusCode: number;
  body: unknown;
  replayed: boolean;
}

export interface ExecuteContext {
  requestId: string;
}

const SAVEPOINT = 'idem_work';

/** Business rejections (422 class) are final answers for a key; everything else may be retried. */
function isStoredRejection(error: unknown): error is AppError {
  return error instanceof AppError && error.status === 422;
}

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly transactions: TransactionRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Runs `work` at most once per (scope, key). The key claim, the money movement and the stored
   * response all commit in one database transaction.
   *
   * Why simultaneous requests with the same key are safe: the claim is an INSERT ... ON CONFLICT
   * on the (scope, key) primary key. While the first request's transaction is open, its claimed
   * row is invisible but its unique index entry is not: the second INSERT blocks on it. When the
   * first commits, the second sees the finished row, the conflict clause does not match (the row
   * has not expired), nothing is returned, and it replays the stored response. If the first rolls
   * back, the second gets to insert the claim and runs the work itself. A very slow first request
   * can make a waiter hit lock_timeout; withTransaction retries it and finally answers RETRY_LATER.
   */
  async execute(
    scope: string,
    key: string,
    requestHash: string,
    work: (tx: Db) => Promise<WorkResult>,
    context: ExecuteContext,
  ): Promise<ExecuteResult> {
    return this.transactions.run(async (tx) => {
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({
          scope,
          key,
          requestHash,
          statusCode: 0,
          responseBody: {},
          expiresAt: sql`now() + make_interval(hours => ${this.config.IDEMPOTENCY_TTL_HOURS})`,
        })
        .onConflictDoUpdate({
          target: [idempotencyKeys.scope, idempotencyKeys.key],
          set: {
            requestHash: sql`excluded.request_hash`,
            statusCode: 0,
            responseBody: sql`'{}'::jsonb`,
            transactionId: null,
            createdAt: sql`now()`,
            expiresAt: sql`excluded.expires_at`,
          },
          // Re-claims an expired key in the same statement.
          setWhere: sql`${idempotencyKeys.expiresAt} < now()`,
        })
        .returning({ scope: idempotencyKeys.scope });

      if (claimed.length === 0) return this.replay(tx, scope, key, requestHash, context);

      // A savepoint lets a business rejection undo any partial work but still commit the key.
      await tx.execute(sql.raw(`SAVEPOINT ${SAVEPOINT}`));
      let result: WorkResult;
      try {
        result = await work(tx);
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${SAVEPOINT}`));
      } catch (raw) {
        // A raw Postgres error that means a business rejection (e.g. 22003 out of range) is
        // treated like the AppError it maps to. 503s and unmapped errors still release the key.
        const error = mapPgError(raw);
        if (!isStoredRejection(error)) throw raw; // rolls back everything, releasing the key
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`));
        result = { statusCode: error.status, body: buildProblem(error, context.requestId) };
      }

      // Read the body back from the row: jsonb normalises key order, so the first response and
      // every replay are serialised from the same value and are byte-identical.
      const [stored] = await tx
        .update(idempotencyKeys)
        .set({
          statusCode: result.statusCode,
          responseBody: result.body,
          transactionId: result.transactionId ?? null,
        })
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .returning({ body: idempotencyKeys.responseBody });
      if (!stored)
        throw new AppError('INTERNAL_ERROR', { detail: 'Idempotency key update failed' });
      return { statusCode: result.statusCode, body: stored.body, replayed: false };
    });
  }

  private async replay(
    tx: Db,
    scope: string,
    key: string,
    requestHash: string,
    context: ExecuteContext,
  ): Promise<ExecuteResult> {
    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    // A committed row always has a real status; anything else means we raced a re-claim.
    if (!existing || existing.statusCode === 0) {
      throw new AppError('RETRY_LATER', { retryAfterSeconds: 1 });
    }
    if (existing.requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        detail: 'This Idempotency-Key was already used with a different request',
      });
    }
    const body = existing.responseBody;
    const isProblem = existing.statusCode >= 400 && typeof body === 'object' && body !== null;
    return {
      statusCode: existing.statusCode,
      // A replayed rejection reports the current request's id so it can be traced.
      body: isProblem ? { ...body, request_id: context.requestId } : body,
      replayed: true,
    };
  }
}
