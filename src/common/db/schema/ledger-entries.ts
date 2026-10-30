import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { currencies } from './currencies';
import { transactions } from './transactions';

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    accountId: uuid('account_id').notNull(),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ledger_entries_amount_non_zero', sql`${t.amount} <> 0`),
    foreignKey({
      name: 'ledger_entries_account_currency_fk',
      columns: [t.accountId, t.currency],
      foreignColumns: [accounts.id, accounts.currency],
    }),
    index('ledger_entries_account_id_idx').on(t.accountId),
    index('ledger_entries_transaction_id_idx').on(t.transactionId),
    index('ledger_entries_created_at_idx').on(t.createdAt),
  ],
);
