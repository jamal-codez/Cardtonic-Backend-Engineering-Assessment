import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { loadConfig } from '../common/config/config';
import { accounts, currencies } from '../common/db/schema';
import { CURRENCIES, CURRENCY_CODES } from '../common/money/currency';
import type { Db } from '../common/db/with-transaction';

const SYSTEM_KINDS = ['external', 'fx_pool'] as const;

/** Idempotent: safe to run on every boot. Existing rows (and their ids) are never replaced. */
export async function seedDatabase(db: Db): Promise<void> {
  await db
    .insert(currencies)
    .values(
      CURRENCY_CODES.map((code) => ({
        code,
        fiatCode: CURRENCIES[code].fiat,
        scale: CURRENCIES[code].scale,
      })),
    )
    .onConflictDoUpdate({
      target: currencies.code,
      set: { fiatCode: sql`excluded.fiat_code`, scale: sql`excluded.scale` },
    });

  await db
    .insert(accounts)
    .values(
      CURRENCY_CODES.flatMap((currency) =>
        SYSTEM_KINDS.map((kind) => ({
          id: uuidv7(),
          kind,
          currency,
          walletId: null,
          balance: null,
        })),
      ),
    )
    .onConflictDoNothing({
      target: [accounts.kind, accounts.currency],
      where: sql`${accounts.kind} <> 'user'`,
    });
}

if (require.main === module) {
  const pool = new Pool({ connectionString: loadConfig().DATABASE_URL, max: 1 });
  seedDatabase(drizzle(pool))
    .then(() => {
      console.log('Seed complete');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
