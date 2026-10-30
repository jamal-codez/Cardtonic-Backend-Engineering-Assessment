import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { currencies } from './currencies';

export const walletActivity = pgTable(
  'wallet_activity',
  {
    id: uuid('id').primaryKey(),
    walletId: uuid('wallet_id').notNull(),
    transactionId: uuid('transaction_id').notNull(),
    activityType: text('activity_type').notNull(),
    currencyOut: text('currency_out').references(() => currencies.code),
    amountOut: bigint('amount_out', { mode: 'bigint' }),
    currencyIn: text('currency_in').references(() => currencies.code),
    amountIn: bigint('amount_in', { mode: 'bigint' }),
    counterpartyWalletId: uuid('counterparty_wallet_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'wallet_activity_type_check',
      sql`${t.activityType} IN ('deposit', 'swap', 'transfer_in', 'transfer_out')`,
    ),
    index('wallet_activity_wallet_created_idx').on(
      t.walletId,
      sql`${t.createdAt} DESC`,
      sql`${t.id} DESC`,
    ),
  ],
);
