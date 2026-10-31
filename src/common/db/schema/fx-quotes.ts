import { sql } from 'drizzle-orm';
import { bigint, check, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { wallets } from './wallets';

/**
 * A rate locked for a short time. Unlike the ledger tables this one is mutable on purpose: `used_at`
 * is set once, when a swap or transfer executes against the quote.
 */
export const fxQuotes = pgTable(
  'fx_quotes',
  {
    id: uuid('id').primaryKey(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id),
    fromCurrency: text('from_currency').notNull(),
    toCurrency: text('to_currency').notNull(),
    sourceAmount: bigint('source_amount', { mode: 'bigint' }).notNull(),
    destAmount: bigint('dest_amount', { mode: 'bigint' }).notNull(),
    rate: numeric('rate', { precision: 30, scale: 12 }).notNull(),
    /** Where the locked rate came from (live or static); executions record `quote`. */
    rateSource: text('rate_source').notNull(),
    rateAsOf: timestamp('rate_as_of', { withTimezone: true }).notNull(),
    /** Application time (Clock) plus the TTL. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('fx_quotes_amounts_check', sql`${t.sourceAmount} > 0 AND ${t.destAmount} > 0`),
    check('fx_quotes_pair_check', sql`${t.fromCurrency} <> ${t.toCurrency}`),
    check('fx_quotes_rate_source_check', sql`${t.rateSource} IN ('live', 'static')`),
    index('fx_quotes_wallet_id_idx').on(t.walletId),
  ],
);
