import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { resetDb } from './helpers/reset-db';
import {
  createUserAccount,
  createWallet,
  failureOf,
  insertEntry,
  insertTransactionRow,
  runAndCommit,
  systemAccountId,
} from './helpers/factories';

describe('ledger database invariants', () => {
  let pool: Pool;
  let walletId: string;
  let userAccount: string;
  let external: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDb(pool);
    walletId = await createWallet(pool);
    userAccount = await createUserAccount(pool, walletId, 'cNGN', 100n);
    external = await systemAccountId(pool, 'external', 'cNGN');
  });

  /** Commits one balanced transaction (+100 user, -100 external) and returns its id. */
  async function commitBalancedTransaction(): Promise<string> {
    const transactionId = uuidv7();
    const error = await runAndCommit(pool, async (client) => {
      await insertTransactionRow(client, { id: transactionId, walletId });
      await insertEntry(client, { transactionId, accountId: userAccount, amount: 100n });
      await insertEntry(client, { transactionId, accountId: external, amount: -100n });
      await client.query(
        `INSERT INTO wallet_activity (id, wallet_id, transaction_id, activity_type, created_at)
         VALUES ($1, $2, $3, 'deposit', now())`,
        [uuidv7(), walletId, transactionId],
      );
    });
    expect(error).toBeUndefined();
    return transactionId;
  }

  describe('zero-sum and minimum-entries triggers', () => {
    it('commits a balanced transaction', async () => {
      await commitBalancedTransaction();
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM ledger_entries');
      expect(rows[0]).toEqual({ n: 2 });
    });

    it('fails at commit with 23514 when entries do not sum to zero', async () => {
      const transactionId = uuidv7();
      const error = await runAndCommit(pool, async (client) => {
        await insertTransactionRow(client, { id: transactionId, walletId });
        await insertEntry(client, { transactionId, accountId: userAccount, amount: 100n });
        await insertEntry(client, { transactionId, accountId: external, amount: -50n });
      });
      expect(error).toMatchObject({ code: '23514', reachedCommit: true });
      expect(error?.message).toMatch(/unbalanced/);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions');
      expect(rows[0]).toEqual({ n: 0 });
    });

    it('fails at commit when a transaction has a single entry', async () => {
      const transactionId = uuidv7();
      const error = await runAndCommit(pool, async (client) => {
        await insertTransactionRow(client, { id: transactionId, walletId });
        await insertEntry(client, { transactionId, accountId: userAccount, amount: 100n });
      });
      expect(error).toMatchObject({ code: '23514', reachedCommit: true });
    });

    it('fails at commit when a transaction has no entries at all', async () => {
      const error = await runAndCommit(pool, async (client) => {
        await insertTransactionRow(client, { walletId });
      });
      expect(error).toMatchObject({ code: '23514', reachedCommit: true });
      expect(error?.message).toMatch(/fewer than 2 entries/);
    });

    it('checks balance per currency, not across currencies', async () => {
      const usdAccount = await createUserAccount(pool, walletId, 'USDx', 0n);
      const usdExternal = await systemAccountId(pool, 'external', 'USDx');
      const transactionId = uuidv7();
      const error = await runAndCommit(pool, async (client) => {
        await insertTransactionRow(client, { id: transactionId, walletId });
        // Sums to zero overall (100 - 100) but not within each currency.
        await insertEntry(client, { transactionId, accountId: userAccount, amount: 100n });
        await insertEntry(client, {
          transactionId,
          accountId: usdExternal,
          currency: 'USDx',
          amount: -100n,
        });
        await insertEntry(client, {
          transactionId,
          accountId: usdAccount,
          currency: 'USDx',
          amount: 1n,
        });
      });
      expect(error).toMatchObject({ code: '23514', reachedCommit: true });
    });
  });

  describe('append-only tables', () => {
    it.each([
      ['UPDATE', 'ledger_entries', 'UPDATE ledger_entries SET amount = amount'],
      ['DELETE', 'ledger_entries', 'DELETE FROM ledger_entries'],
      ['UPDATE', 'transactions', `UPDATE transactions SET status = 'completed'`],
      ['DELETE', 'transactions', 'DELETE FROM transactions'],
      ['UPDATE', 'wallet_activity', 'UPDATE wallet_activity SET currency_in = NULL'],
      ['DELETE', 'wallet_activity', 'DELETE FROM wallet_activity'],
    ])('rejects %s on %s with 0A000', async (_verb, _table, statement) => {
      await commitBalancedTransaction();
      const error = await failureOf(pool, statement);
      expect(error).toMatchObject({ code: '0A000', message: 'append-only table' });
    });
  });

  describe('account CHECK constraints', () => {
    it('rejects a user balance below zero', async () => {
      const error = await failureOf(pool, 'UPDATE accounts SET balance = -1 WHERE id = $1', [
        userAccount,
      ]);
      expect(error).toMatchObject({ code: '23514' });
      expect(error?.message).toMatch(/accounts_balance_non_negative/);
    });

    it('rejects a user account with a NULL balance', async () => {
      const error = await failureOf(
        pool,
        `INSERT INTO accounts (id, wallet_id, currency, kind, balance) VALUES ($1, $2, 'USDx', 'user', NULL)`,
        [uuidv7(), walletId],
      );
      expect(error).toMatchObject({ code: '23514' });
    });

    it('rejects a system account that stores a balance', async () => {
      const error = await failureOf(pool, 'UPDATE accounts SET balance = 0 WHERE id = $1', [
        external,
      ]);
      expect(error).toMatchObject({ code: '23514' });
    });

    it('rejects a user account without a wallet', async () => {
      const error = await failureOf(
        pool,
        `INSERT INTO accounts (id, currency, kind, balance) VALUES ($1, 'USDx', 'user', 0)`,
        [uuidv7()],
      );
      expect(error).toMatchObject({ code: '23514' });
    });

    it('rejects a second user account for the same wallet and currency', async () => {
      await expect(createUserAccount(pool, walletId, 'cNGN')).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('rejects a second system account of the same kind and currency', async () => {
      const error = await failureOf(
        pool,
        `INSERT INTO accounts (id, currency, kind) VALUES ($1, 'cNGN', 'external')`,
        [uuidv7()],
      );
      expect(error).toMatchObject({ code: '23505' });
    });

    it('rejects an entry whose currency differs from its account currency', async () => {
      const transactionId = uuidv7();
      const error = await runAndCommit(pool, async (client) => {
        await insertTransactionRow(client, { id: transactionId, walletId });
        await insertEntry(client, {
          transactionId,
          accountId: userAccount,
          currency: 'USDx',
          amount: 100n,
        });
      });
      expect(error).toMatchObject({ code: '23503', reachedCommit: false });
    });
  });

  describe('wallets', () => {
    it('rejects a second wallet with the same email, ignoring case', async () => {
      await createWallet(pool, { email: 'Ada@Example.test' });
      await expect(createWallet(pool, { email: 'ada@example.TEST' })).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('rejects a wallet with neither email nor phone', async () => {
      const error = await failureOf(pool, 'INSERT INTO wallets (id) VALUES ($1)', [uuidv7()]);
      expect(error).toMatchObject({ code: '23514' });
    });
  });
});
