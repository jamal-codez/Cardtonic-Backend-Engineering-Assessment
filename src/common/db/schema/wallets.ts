import { sql } from 'drizzle-orm';
import { check, customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Case-insensitive text (needs the citext extension, created in migration 0000). */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').unique(),
    phone: text('phone').unique(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('wallets_status_check', sql`${t.status} IN ('active', 'frozen')`),
    check('wallets_contact_check', sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`),
  ],
);
