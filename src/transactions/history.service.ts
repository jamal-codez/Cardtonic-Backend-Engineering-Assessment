import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../common/db/database.module';
import { wallets } from '../common/db/schema';
import type { Db } from '../common/db/with-transaction';
import { AppError } from '../common/errors/app-error';
import { parseCurrency } from '../common/money/currency';
import { decodeCursor, encodeCursor } from './cursor';
import type { HistoryQueryDto } from './dto/history-query.dto';
import { toHistoryItem, type HistoryItem, type HistoryRow } from './transaction.mapper';

const DEFAULT_LIMIT = 20n;
const MAX_LIMIT = 100n;

export interface HistoryPage {
  data: HistoryItem[];
  next_cursor: string | null;
}

/** Read side of wallet_activity: keyset pagination, newest first. */
@Injectable()
export class HistoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(walletId: string, query: HistoryQueryDto): Promise<HistoryPage> {
    // Validate everything before touching the database.
    const limit = this.parseLimit(query.limit);
    const currency = query.currency === undefined ? undefined : parseCurrency(query.currency);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    if (!wallet) throw new AppError('WALLET_NOT_FOUND');

    const conditions: SQL[] = [sql`a.wallet_id = ${walletId}`];
    if (query.type) conditions.push(sql`a.activity_type = ${query.type}`);
    if (currency)
      conditions.push(sql`(a.currency_out = ${currency} OR a.currency_in = ${currency})`);
    // (created_at, id) is unique and totally ordered, so the keyset never skips or repeats a row.
    if (cursor) {
      conditions.push(sql`(a.created_at, a.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`);
    }

    // One extra row tells us whether another page exists. The limit is bound as text and cast in
    // SQL because amounts and counts in this codebase never go through Number().
    const result = await this.db.execute(sql`
      SELECT a.id, a.transaction_id, a.activity_type, a.currency_out, a.amount_out,
             a.currency_in, a.amount_in, a.counterparty_wallet_id,
             to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us,
             t.rate::text AS rate, t.rate_source
        FROM wallet_activity a
        JOIN transactions t ON t.id = a.transaction_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limit.toString()}::int + 1`);
    const rows = result.rows as unknown as HistoryRow[];

    const hasMore = BigInt(rows.length) > limit;
    if (hasMore) rows.pop();
    const last = rows[rows.length - 1];
    return {
      data: rows.map(toHistoryItem),
      next_cursor: hasMore && last ? encodeCursor({ t: last.created_at_us, id: last.id }) : null,
    };
  }

  private parseLimit(raw: string | undefined): bigint {
    if (raw === undefined) return DEFAULT_LIMIT;
    const limit = BigInt(raw); // the DTO already guarantees 1 to 3 digits
    if (limit < 1n || limit > MAX_LIMIT) {
      throw new AppError('VALIDATION_ERROR', {
        detail: 'limit must be an integer between 1 and 100',
        errors: [{ field: 'limit', message: 'limit must be an integer between 1 and 100' }],
      });
    }
    return limit;
  }
}
