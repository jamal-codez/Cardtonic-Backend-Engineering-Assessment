import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { currencies } from './currencies';
import { wallets } from './wallets';

/**
 * User accounts hold a stored balance (>= 0). System accounts (external, fx_pool) have a NULL
 * balance: their balance is the sum of their entries, so they never become hot rows.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    walletId: uuid('wallet_id').references(() => wallets.id),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    kind: text('kind').notNull(),
    balance: bigint('balance', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('accounts_kind_check', sql`${t.kind} IN ('user', 'external', 'fx_pool')`),
    check('accounts_balance_non_negative', sql`${t.balance} IS NULL OR ${t.balance} >= 0`),
    check('accounts_user_has_balance', sql`(${t.kind} = 'user') = (${t.balance} IS NOT NULL)`),
    check('accounts_user_has_wallet', sql`(${t.kind} = 'user') = (${t.walletId} IS NOT NULL)`),
    uniqueIndex('accounts_user_wallet_currency_uq')
      .on(t.walletId, t.currency)
      .where(sql`${t.kind} = 'user'`),
    uniqueIndex('accounts_system_kind_currency_uq')
      .on(t.kind, t.currency)
      .where(sql`${t.kind} <> 'user'`),
    index('accounts_user_updated_at_idx')
      .on(t.updatedAt)
      .where(sql`${t.kind} = 'user'`),
    // Target of the composite foreign key from ledger_entries: an entry can never carry a
    // currency different from its account's.
    unique('accounts_id_currency_uq').on(t.id, t.currency),
  ],
);
