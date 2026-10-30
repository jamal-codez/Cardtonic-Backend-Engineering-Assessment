import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { PG_POOL } from '../common/db/database.module';
import { CURRENCY_CODES } from '../common/money/currency';
import { formatAmount } from '../common/money/money';
import type {
  DriftItem,
  ReconcileResult,
  ReconMode,
  ReconciliationRun,
  UnbalancedTransaction,
} from './reconciliation.types';

/** Arbitrary constant; every process that reconciles must use the same one. */
export const RECON_LOCK_ID = 727_002;

const MICROSECOND_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * Accounts in scope: all of them for a full run; for an incremental run those whose row was
 * updated inside the window, plus those that received an entry inside it (so an entry posted
 * without touching the account row is still re-checked).
 */
const ACCOUNT_IN_SCOPE = `($1::timestamptz IS NULL
       OR a.updated_at >= $1::timestamptz
       OR a.id IN (SELECT e.account_id FROM ledger_entries e WHERE e.created_at >= $1::timestamptz))`;

interface Snapshot {
  startedAt: string;
  windowFrom: string | null;
  accountsChecked: number;
  drift: DriftItem[];
  currencyNet: Record<string, string>;
  unbalancedTx: UnbalancedTransaction[];
}

interface RunRow {
  id: string;
  mode: ReconMode;
  started_at: Date;
  finished_at: Date;
  window_from: Date | null;
  accounts_checked: number;
  drift: DriftItem[];
  currency_net: Record<string, string>;
  unbalanced_tx: UnbalancedTransaction[];
  ok: boolean;
}

const toRun = (row: RunRow): ReconciliationRun => ({
  id: row.id,
  mode: row.mode,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  windowFrom: row.window_from,
  accountsChecked: row.accounts_checked,
  drift: row.drift,
  currencyNet: row.currency_net,
  unbalancedTx: row.unbalanced_tx,
  ok: row.ok,
});

/**
 * Checks that the ledger agrees with itself and reports what it finds. It only ever READS the
 * ledger: there is no repair path anywhere. A repair would have to decide which side is right,
 * and a ledger that silently "fixes" its own disagreements hides the bug that caused them.
 *
 * All reads come from one REPEATABLE READ snapshot, so the account count, the drift list, the
 * per-currency nets and the entry counts all describe the same instant. Each check is a single
 * statement and would be self-consistent even under READ COMMITTED; the snapshot is what keeps
 * the four result sets consistent with each other (and keeps any check that is ever split into
 * two statements, such as "read the balance, then sum the entries", from reporting drift that is
 * only a transfer committing in between).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async latest(): Promise<ReconciliationRun | null> {
    const { rows } = await this.pool.query<RunRow>(
      'SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1',
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  /**
   * Runs one reconciliation, or returns { skipped: true } when another run (in this process or
   * another replica) holds the advisory lock. The whole run uses one dedicated connection.
   */
  async run(mode: ReconMode): Promise<ReconcileResult> {
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [RECON_LOCK_ID],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) return { skipped: true };

      const snapshot = await this.readSnapshot(client, mode);
      const ok = this.isOk(snapshot);
      const id = uuidv7();
      // Logged before the run row is written: if recording fails, the drift is still on record.
      if (!ok) this.reportDrift(id, mode, snapshot);
      return await this.record(client, id, mode, snapshot, ok);
    } catch (error) {
      broken = true; // do not hand a connection in an unknown state back to the pool
      throw error;
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [RECON_LOCK_ID]);
        } catch {
          broken = true; // a failed unlock may leave the session lock held: close the connection
        }
      }
      client.release(broken ? true : undefined);
    }
  }

  /**
   * One snapshot, no locks. Why the incremental scope is a time window and not an entry-id
   * watermark: identity ids are handed out when a row is inserted, not when it commits, so a
   * transaction holding a lower id can commit after one holding a higher id. A watermark of
   * "highest id checked" would then skip the late-committing lower id for ever. Accounts and
   * transactions touched in the last RECON_OVERLAP_MS before the previous successful run are
   * simply checked again; since the check is a pure read, re-checking costs nothing but time.
   */
  private async readSnapshot(client: PoolClient, mode: ReconMode): Promise<Snapshot> {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = '60s'`);

      // started_at is the snapshot's own now(); both timestamps keep microsecond precision.
      const meta = await client.query<{ started_at: string; window_from: string | null }>(
        mode === 'incremental'
          ? `SELECT to_char(now() AT TIME ZONE 'UTC', ${MICROSECOND_ISO}) AS started_at,
                    (SELECT to_char((r.started_at - ($1::bigint * interval '1 millisecond'))
                                    AT TIME ZONE 'UTC', ${MICROSECOND_ISO})
                       FROM reconciliation_runs r WHERE r.ok ORDER BY r.started_at DESC LIMIT 1
                    ) AS window_from`
          : `SELECT to_char(now() AT TIME ZONE 'UTC', ${MICROSECOND_ISO}) AS started_at,
                    NULL::text AS window_from`,
        mode === 'incremental' ? [String(this.config.RECON_OVERLAP_MS)] : [],
      );
      const startedAt = meta.rows[0]?.started_at ?? '';
      // With no earlier OK run an incremental run has nothing to be incremental from: full scope.
      const windowFrom = meta.rows[0]?.window_from ?? null;

      const checked = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM accounts a
          WHERE a.kind = 'user' AND ${ACCOUNT_IN_SCOPE}`,
        [windowFrom],
      );

      // (a) every user account's stored balance against the sum of its own entries.
      const balances = await client.query<{
        account_id: string;
        wallet_id: string | null;
        currency: string;
        stored: string;
        expected: string;
      }>(
        `SELECT a.id AS account_id, a.wallet_id, a.currency, a.balance::text AS stored,
                s.total::text AS expected
           FROM accounts a
          CROSS JOIN LATERAL (
                  SELECT COALESCE(SUM(e.amount), 0) AS total
                    FROM ledger_entries e WHERE e.account_id = a.id) s
          WHERE a.kind = 'user'
            AND ${ACCOUNT_IN_SCOPE}
            AND a.balance <> s.total
          ORDER BY a.id`,
        [windowFrom],
      );
      const drift = balances.rows.map<DriftItem>((row) => ({
        account_id: row.account_id,
        wallet_id: row.wallet_id,
        currency: row.currency,
        stored: formatAmount(BigInt(row.stored)),
        expected: formatAmount(BigInt(row.expected)),
        delta: formatAmount(BigInt(row.stored) - BigInt(row.expected)),
      }));

      // (b) the net of all entries, per currency, must be zero.
      const nets = await client.query<{ currency: string; net: string }>(
        windowFrom === null
          ? `SELECT e.currency, COALESCE(SUM(e.amount), 0)::text AS net
               FROM ledger_entries e GROUP BY e.currency`
          : `SELECT e.currency, COALESCE(SUM(e.amount), 0)::text AS net
               FROM ledger_entries e JOIN transactions t ON t.id = e.transaction_id
              WHERE t.created_at >= $1::timestamptz GROUP BY e.currency`,
        windowFrom === null ? [] : [windowFrom],
      );
      const currencyNet: Record<string, string> = Object.fromEntries(
        CURRENCY_CODES.map((code) => [code, formatAmount(0n)]),
      );
      for (const row of nets.rows) currencyNet[row.currency] = formatAmount(BigInt(row.net));

      // (c) every transaction has at least two entries.
      const thin = await client.query<{ transaction_id: string; entries: number }>(
        `SELECT t.id AS transaction_id, count(e.id)::int AS entries
           FROM transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
          WHERE ($1::timestamptz IS NULL OR t.created_at >= $1::timestamptz)
          GROUP BY t.id HAVING count(e.id) < 2 ORDER BY t.id`,
        [windowFrom],
      );

      await client.query('COMMIT'); // releases the snapshot before anything is written
      return {
        startedAt,
        windowFrom,
        accountsChecked: checked.rows[0]?.n ?? 0,
        drift,
        currencyNet,
        unbalancedTx: thin.rows,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /** The only writes: the run row and, optionally, freezing the wallets that drifted. */
  private async record(
    client: PoolClient,
    id: string,
    mode: ReconMode,
    snapshot: Snapshot,
    ok: boolean,
  ): Promise<ReconciliationRun> {
    await client.query('BEGIN');
    try {
      const inserted = await client.query<RunRow>(
        `INSERT INTO reconciliation_runs
           (id, mode, started_at, window_from, accounts_checked, drift, currency_net,
            unbalanced_tx, ok)
         VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
         RETURNING *`,
        [
          id,
          mode,
          snapshot.startedAt,
          snapshot.windowFrom,
          snapshot.accountsChecked,
          JSON.stringify(snapshot.drift),
          JSON.stringify(snapshot.currencyNet),
          JSON.stringify(snapshot.unbalancedTx),
          ok,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('reconciliation run insert returned no row');

      if (this.config.RECON_FREEZE_ON_DRIFT && snapshot.drift.length > 0) {
        const walletIds = [
          ...new Set(snapshot.drift.flatMap((item) => (item.wallet_id ? [item.wallet_id] : []))),
        ];
        await client.query(
          `UPDATE wallets SET status = 'frozen' WHERE id = ANY($1::uuid[]) AND status <> 'frozen'`,
          [walletIds],
        );
      }
      await client.query('COMMIT');
      return toRun(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private isOk(snapshot: Snapshot): boolean {
    const netsAreZero = Object.values(snapshot.currencyNet).every(
      (net) => net === formatAmount(0n),
    );
    return snapshot.drift.length === 0 && netsAreZero && snapshot.unbalancedTx.length === 0;
  }

  /** Account ids and deltas only: no personal data. */
  private reportDrift(id: string, mode: ReconMode, snapshot: Snapshot): void {
    this.logger.error(
      {
        run_id: id,
        mode,
        drift: snapshot.drift.map(({ account_id, wallet_id, currency, delta }) => ({
          account_id,
          wallet_id,
          currency,
          delta,
        })),
        currency_net: snapshot.currencyNet,
        unbalanced_transactions: snapshot.unbalancedTx,
        frozen_wallets: this.config.RECON_FREEZE_ON_DRIFT,
      },
      'Reconciliation found drift: balances were NOT changed',
    );
  }
}
