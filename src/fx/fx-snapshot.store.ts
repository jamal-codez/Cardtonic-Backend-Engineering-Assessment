import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DRIZZLE } from '../common/db/database.module';
import { fxRateSnapshots } from '../common/db/schema';
import type { Db } from '../common/db/with-transaction';
import { usdRatesSchema, type FxSource, type UsdRates } from './fx-provider';
import type { FxSnapshot } from './fx-snapshot';

/** How many of the newest rows `latest()` will inspect before giving up. */
const LOOKBACK = 20;

export interface NewSnapshot {
  usdRates: UsdRates;
  source: FxSource;
  asOf: Date;
}

/** Persistence of the rate-table log. Holds no state of its own. */
@Injectable()
export class FxSnapshotStore {
  private readonly logger = new Logger(FxSnapshotStore.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** The most recent snapshot (of the given source, if any), or null when there is none. */
  async latest(source?: FxSource): Promise<FxSnapshot | null> {
    const rows = await this.db
      .select()
      .from(fxRateSnapshots)
      .where(source ? eq(fxRateSnapshots.source, source) : undefined)
      .orderBy(desc(fxRateSnapshots.fetchedAt), desc(fxRateSnapshots.id))
      .limit(LOOKBACK);

    // Skip unreadable rows instead of giving up, so one bad row cannot discard a good older one.
    for (const row of rows) {
      const rates = usdRatesSchema.safeParse(row.rates);
      if (!rates.success || (row.source !== 'live' && row.source !== 'static')) {
        this.logger.warn({ snapshot_id: row.id }, 'Ignoring unreadable stored FX snapshot');
        continue;
      }
      return {
        usdRates: rates.data,
        source: row.source,
        asOf: row.providerUpdatedAt,
        fetchedAt: row.fetchedAt,
      };
    }
    return null;
  }

  /** Stores a snapshot and returns the database's `fetched_at` for it. */
  async insert(snapshot: NewSnapshot): Promise<Date> {
    const [row] = await this.db
      .insert(fxRateSnapshots)
      .values({
        id: uuidv7(),
        base: 'USD',
        rates: snapshot.usdRates,
        source: snapshot.source,
        providerUpdatedAt: snapshot.asOf,
      })
      .returning({ fetchedAt: fxRateSnapshots.fetchedAt });
    if (!row) throw new Error('FX snapshot insert returned no row');
    return row.fetchedAt;
  }
}
