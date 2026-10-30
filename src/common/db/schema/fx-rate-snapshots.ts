import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** A log of fetched rate tables. Not append-only by trigger; it is only a history. */
export const fxRateSnapshots = pgTable(
  'fx_rate_snapshots',
  {
    id: uuid('id').primaryKey(),
    base: text('base').notNull().default('USD'),
    rates: jsonb('rates').notNull(),
    source: text('source').notNull(),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('fx_rate_snapshots_source_check', sql`${t.source} IN ('live', 'static')`),
    index('fx_rate_snapshots_fetched_at_idx').on(sql`${t.fetchedAt} DESC`),
  ],
);
