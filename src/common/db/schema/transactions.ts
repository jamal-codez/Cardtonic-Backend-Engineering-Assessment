import { sql } from 'drizzle-orm';
import { bigint, check, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { currencies } from './currencies';

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status').notNull().default('completed'),
    initiatorWalletId: uuid('initiator_wallet_id').notNull(),
    counterpartyWalletId: uuid('counterparty_wallet_id'),
    sourceCurrency: text('source_currency')
      .notNull()
      .references(() => currencies.code),
    sourceAmount: bigint('source_amount', { mode: 'bigint' }).notNull(),
    destCurrency: text('dest_currency')
      .notNull()
      .references(() => currencies.code),
    destAmount: bigint('dest_amount', { mode: 'bigint' }).notNull(),
    rate: numeric('rate', { precision: 30, scale: 12 }),
    rateSource: text('rate_source'),
    rateAsOf: timestamp('rate_as_of', { withTimezone: true }),
    quoteId: uuid('quote_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Supports the incremental reconciliation window.
    index('transactions_created_at_idx').on(t.createdAt),
    check('transactions_type_check', sql`${t.type} IN ('deposit', 'swap', 'transfer')`),
    check('transactions_source_amount_positive', sql`${t.sourceAmount} > 0`),
    check('transactions_dest_amount_positive', sql`${t.destAmount} > 0`),
    check(
      'transactions_rate_source_check',
      sql`${t.rateSource} IS NULL OR ${t.rateSource} IN ('live', 'cached', 'static', 'quote')`,
    ),
  ],
);
