import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** One row per completed reconciliation. Reconciliation only reads the ledger; it never repairs. */
export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey(),
    mode: text('mode').notNull(),
    /** The snapshot's own now(); the next incremental window starts from the last OK run's value. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
    /** Lower bound of the incremental scope; null for a full run. */
    windowFrom: timestamp('window_from', { withTimezone: true }),
    accountsChecked: integer('accounts_checked').notNull(),
    drift: jsonb('drift').notNull(),
    currencyNet: jsonb('currency_net').notNull(),
    unbalancedTx: jsonb('unbalanced_tx').notNull(),
    ok: boolean('ok').notNull(),
  },
  (t) => [
    check('reconciliation_runs_mode_check', sql`${t.mode} IN ('incremental', 'full')`),
    index('reconciliation_runs_started_at_idx').on(sql`${t.startedAt} DESC`),
  ],
);
