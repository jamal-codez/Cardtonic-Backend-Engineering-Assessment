import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const currencies = pgTable('currencies', {
  code: text('code').primaryKey(),
  fiatCode: text('fiat_code').notNull(),
  scale: integer('scale').notNull(),
});
