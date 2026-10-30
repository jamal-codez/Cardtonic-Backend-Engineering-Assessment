import type { Pool, PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';

type Queryable = Pool | PoolClient;

export async function createWallet(
  db: Queryable,
  options: { email?: string; phone?: string; status?: 'active' | 'frozen' } = {},
): Promise<string> {
  const id = uuidv7();
  await db.query('INSERT INTO wallets (id, email, phone, status) VALUES ($1, $2, $3, $4)', [
    id,
    options.email ?? `${id}@example.test`,
    options.phone ?? null,
    options.status ?? 'active',
  ]);
  return id;
}

export async function createUserAccount(
  db: Queryable,
  walletId: string,
  currency: string,
  balance = 0n,
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO accounts (id, wallet_id, currency, kind, balance) VALUES ($1, $2, $3, 'user', $4)`,
    [id, walletId, currency, balance.toString()],
  );
  return id;
}

export async function systemAccountId(
  db: Queryable,
  kind: 'external' | 'fx_pool',
  currency: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM accounts WHERE kind = $1 AND currency = $2',
    [kind, currency],
  );
  const row = rows[0];
  if (!row) throw new Error(`system account ${kind}/${currency} not seeded`);
  return row.id;
}

export async function insertTransactionRow(
  db: Queryable,
  options: { id?: string; walletId: string; currency?: string; amount?: bigint },
): Promise<string> {
  const id = options.id ?? uuidv7();
  const currency = options.currency ?? 'cNGN';
  const amount = (options.amount ?? 100n).toString();
  await db.query(
    `INSERT INTO transactions
       (id, type, initiator_wallet_id, source_currency, source_amount, dest_currency, dest_amount)
     VALUES ($1, 'deposit', $2, $3, $4, $3, $4)`,
    [id, options.walletId, currency, amount],
  );
  return id;
}

export async function insertEntry(
  db: Queryable,
  options: { transactionId: string; accountId: string; currency?: string; amount: bigint },
): Promise<void> {
  await db.query(
    'INSERT INTO ledger_entries (transaction_id, account_id, currency, amount) VALUES ($1, $2, $3, $4)',
    [
      options.transactionId,
      options.accountId,
      options.currency ?? 'cNGN',
      options.amount.toString(),
    ],
  );
}

export interface DbError {
  code?: string;
  message: string;
  reachedCommit: boolean;
}

/**
 * Runs `work` in a transaction and COMMITs. Returns the failure (and whether it only happened at
 * COMMIT, i.e. from a deferred trigger) or undefined when everything succeeded.
 */
export async function runAndCommit(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<DbError | undefined> {
  const client = await pool.connect();
  let reachedCommit = false;
  try {
    await client.query('BEGIN');
    await work(client);
    reachedCommit = true;
    await client.query('COMMIT');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? String(error), reachedCommit };
  } finally {
    client.release();
  }
}

/** Runs a single statement and returns the error it raised, if any. */
export async function failureOf(
  db: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<{ code?: string; message: string } | undefined> {
  try {
    await db.query(sql, params);
    return undefined;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? String(error) };
  }
}
