import { createTestApp, type TestApp } from './helpers/create-test-app';
import { createUserAccount, createWallet, systemAccountId } from './helpers/factories';
import type { PostInput } from '../src/ledger/ledger.types';

async function count(t: TestApp, table: string): Promise<number> {
  const { rows } = await t.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? -1;
}

async function balanceOf(t: TestApp, accountId: string): Promise<bigint> {
  const { rows } = await t.pool.query<{ balance: string }>(
    'SELECT balance FROM accounts WHERE id = $1',
    [accountId],
  );
  return BigInt(rows[0]?.balance ?? '-1');
}

describe('LedgerService.post', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  /** Deposit-shaped posting: credit the user account, debit the system `external` account. */
  async function depositInput(walletId: string, userAccount: string, amount: bigint) {
    const external = await t.ledger.getSystemAccountId('external', 'cNGN');
    const input: PostInput = {
      transaction: {
        type: 'deposit',
        initiatorWalletId: walletId,
        sourceCurrency: 'cNGN',
        sourceAmount: amount,
        destCurrency: 'cNGN',
        destAmount: amount,
      },
      legs: [
        { accountId: userAccount, amount },
        { accountId: external, amount: -amount },
      ],
      activity: [{ walletId, activityType: 'deposit', currencyIn: 'cNGN', amountIn: amount }],
    };
    return input;
  }

  function transferInput(
    from: { wallet: string; account: string },
    to: typeof from,
    amount: bigint,
  ) {
    const input: PostInput = {
      transaction: {
        type: 'transfer',
        initiatorWalletId: from.wallet,
        counterpartyWalletId: to.wallet,
        sourceCurrency: 'cNGN',
        sourceAmount: amount,
        destCurrency: 'cNGN',
        destAmount: amount,
      },
      legs: [
        { accountId: from.account, amount: -amount },
        { accountId: to.account, amount },
      ],
      activity: [],
    };
    return input;
  }

  it('applies a balanced deposit: updates the balance, writes 2 entries and 1 activity row', async () => {
    const walletId = await createWallet(t.pool);
    const userAccount = await createUserAccount(t.pool, walletId, 'cNGN');

    const result = await t.transactions.run(async (tx) =>
      t.ledger.post(tx, await depositInput(walletId, userAccount, 5_000_000n)),
    );

    expect(result.balances.get(userAccount)).toBe(5_000_000n);
    expect(await balanceOf(t, userAccount)).toBe(5_000_000n);
    expect(await count(t, 'transactions')).toBe(1);
    expect(await count(t, 'ledger_entries')).toBe(2);
    expect(await count(t, 'wallet_activity')).toBe(1);

    const { rows } = await t.pool.query<{ same: boolean }>(
      `SELECT a.created_at = t.created_at AS same
         FROM wallet_activity a JOIN transactions t ON t.id = a.transaction_id`,
    );
    expect(rows[0]?.same).toBe(true);
  });

  it('throws INSUFFICIENT_FUNDS on an overdraft and writes nothing', async () => {
    const wallet = await createWallet(t.pool);
    const account = await createUserAccount(t.pool, wallet, 'cNGN', 50n);
    const other = await createWallet(t.pool);
    const otherAccount = await createUserAccount(t.pool, other, 'cNGN');

    await expect(
      t.transactions.run((tx) =>
        t.ledger.post(
          tx,
          transferInput({ wallet, account }, { wallet: other, account: otherAccount }, 51n),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', status: 422 });

    expect(await balanceOf(t, account)).toBe(50n);
    expect(await balanceOf(t, otherAccount)).toBe(0n);
    expect(await count(t, 'transactions')).toBe(0);
    expect(await count(t, 'ledger_entries')).toBe(0);
    expect(await count(t, 'wallet_activity')).toBe(0);
  });

  it('allows spending the exact balance down to zero', async () => {
    const wallet = await createWallet(t.pool);
    const account = await createUserAccount(t.pool, wallet, 'cNGN', 50n);
    const other = await createWallet(t.pool);
    const otherAccount = await createUserAccount(t.pool, other, 'cNGN');

    await t.transactions.run((tx) =>
      t.ledger.post(
        tx,
        transferInput({ wallet, account }, { wallet: other, account: otherAccount }, 50n),
      ),
    );
    expect(await balanceOf(t, account)).toBe(0n);
    expect(await balanceOf(t, otherAccount)).toBe(50n);
  });

  it('rejects a debit from a frozen wallet but accepts a credit to one', async () => {
    const frozen = await createWallet(t.pool, { status: 'frozen' });
    const frozenAccount = await createUserAccount(t.pool, frozen, 'cNGN', 100n);
    const active = await createWallet(t.pool);
    const activeAccount = await createUserAccount(t.pool, active, 'cNGN', 100n);

    await expect(
      t.transactions.run((tx) =>
        t.ledger.post(
          tx,
          transferInput(
            { wallet: frozen, account: frozenAccount },
            { wallet: active, account: activeAccount },
            10n,
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'WALLET_FROZEN' });

    await t.transactions.run((tx) =>
      t.ledger.post(
        tx,
        transferInput(
          { wallet: active, account: activeAccount },
          { wallet: frozen, account: frozenAccount },
          10n,
        ),
      ),
    );
    expect(await balanceOf(t, frozenAccount)).toBe(110n);
  });

  it('fails fast with INTERNAL_ERROR when legs do not sum to zero, before writing anything', async () => {
    const walletId = await createWallet(t.pool);
    const userAccount = await createUserAccount(t.pool, walletId, 'cNGN');
    const external = await systemAccountId(t.pool, 'external', 'cNGN');
    const input = await depositInput(walletId, userAccount, 100n);
    input.legs = [
      { accountId: userAccount, amount: 100n },
      { accountId: external, amount: -99n },
    ];

    await expect(t.transactions.run((tx) => t.ledger.post(tx, input))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(await count(t, 'transactions')).toBe(0);
  });

  it('never locks system accounts, so concurrent deposits on one external account succeed', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const walletId = await createWallet(t.pool);
        return { walletId, account: await createUserAccount(t.pool, walletId, 'cNGN') };
      }),
    );
    await Promise.all(
      wallets.map(async ({ walletId, account }) =>
        t.transactions.run(async (tx) =>
          t.ledger.post(tx, await depositInput(walletId, account, 7n)),
        ),
      ),
    );
    const external = await systemAccountId(t.pool, 'external', 'cNGN');
    const { rows } = await t.pool.query<{ sum: string }>(
      'SELECT sum(amount) AS sum FROM ledger_entries WHERE account_id = $1',
      [external],
    );
    expect(rows[0]?.sum).toBe('-70');
  });

  it('does not deadlock when opposite-direction postings touch the same two accounts', async () => {
    const a = { wallet: await createWallet(t.pool), account: '' };
    a.account = await createUserAccount(t.pool, a.wallet, 'cNGN', 1_000n);
    const b = { wallet: await createWallet(t.pool), account: '' };
    b.account = await createUserAccount(t.pool, b.wallet, 'cNGN', 1_000n);

    const jobs = Array.from({ length: 40 }, (_unused, i) =>
      t.transactions.run((tx) =>
        t.ledger.post(tx, i % 2 === 0 ? transferInput(a, b, 1n) : transferInput(b, a, 1n)),
      ),
    );
    const outcomes = await Promise.allSettled(jobs);

    expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([]);
    // 20 each way: balances unchanged, and stored balances match the entries.
    expect(await balanceOf(t, a.account)).toBe(1_000n);
    expect(await balanceOf(t, b.account)).toBe(1_000n);
    const { rows } = await t.pool.query<{ sum: string }>(
      'SELECT sum(amount) AS sum FROM ledger_entries WHERE account_id = $1',
      [a.account],
    );
    expect(rows[0]?.sum).toBe('0');
  });

  it('never needs a deadlock retry for opposite-direction postings', async () => {
    const a = { wallet: await createWallet(t.pool), account: '' };
    a.account = await createUserAccount(t.pool, a.wallet, 'cNGN', 1_000n);
    const b = { wallet: await createWallet(t.pool), account: '' };
    b.account = await createUserAccount(t.pool, b.wallet, 'cNGN', 1_000n);
    // withTransaction sleeps only before a retry, so zero sleeps means zero 40P01/40001/55P03.
    const sleep = jest.fn(() => Promise.resolve());

    await Promise.all(
      Array.from({ length: 40 }, (_unused, i) =>
        t.transactions.run(
          (tx) =>
            t.ledger.post(tx, i % 2 === 0 ? transferInput(a, b, 1n) : transferInput(b, a, 1n)),
          { sleep },
        ),
      ),
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('lets exactly one of two concurrent overdrafts succeed', async () => {
    const from = { wallet: await createWallet(t.pool), account: '' };
    from.account = await createUserAccount(t.pool, from.wallet, 'cNGN', 100n);
    const to = { wallet: await createWallet(t.pool), account: '' };
    to.account = await createUserAccount(t.pool, to.wallet, 'cNGN');

    const outcomes = await Promise.allSettled([
      t.transactions.run((tx) => t.ledger.post(tx, transferInput(from, to, 60n))),
      t.transactions.run((tx) => t.ledger.post(tx, transferInput(from, to, 60n))),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'INSUFFICIENT_FUNDS' } });
    expect(await balanceOf(t, from.account)).toBe(40n);
    expect(await balanceOf(t, to.account)).toBe(60n);
  });

  it('keeps every stored balance equal to the sum of its entries', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const wallet = await createWallet(t.pool);
        return { wallet, account: await createUserAccount(t.pool, wallet, 'cNGN') };
      }),
    );
    await Promise.all(
      wallets.map(async ({ wallet, account }) =>
        t.transactions.run(async (tx) =>
          t.ledger.post(tx, await depositInput(wallet, account, 500n)),
        ),
      ),
    );
    await Promise.all(
      [0, 1, 2, 3].flatMap((i) => {
        const from = wallets[i];
        const to = wallets[(i + 1) % 4];
        if (!from || !to) return [];
        return [10n, 20n, 30n].map((amount) =>
          t.transactions.run((tx) => t.ledger.post(tx, transferInput(from, to, amount))),
        );
      }),
    );

    const { rows } = await t.pool.query<{ account_id: string; stored: string; summed: string }>(
      `SELECT a.id AS account_id, a.balance AS stored,
              coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.account_id = a.id), 0) AS summed
         FROM accounts a WHERE a.kind = 'user'`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.stored).toBe(row.summed);
  });

  it('posts a swap-shaped transaction: four legs across two currencies through fx_pool', async () => {
    const walletId = await createWallet(t.pool);
    const ngn = await createUserAccount(t.pool, walletId, 'cNGN', 1_500_000n);
    const usd = await createUserAccount(t.pool, walletId, 'USDx');
    const poolNgn = await t.ledger.getSystemAccountId('fx_pool', 'cNGN');
    const poolUsd = await t.ledger.getSystemAccountId('fx_pool', 'USDx');

    const result = await t.transactions.run((tx) =>
      t.ledger.post(tx, {
        transaction: {
          type: 'swap',
          initiatorWalletId: walletId,
          sourceCurrency: 'cNGN',
          sourceAmount: 1_500_000n,
          destCurrency: 'USDx',
          destAmount: 1_000n,
          rate: '0.000666666667',
          rateSource: 'static',
          rateAsOf: new Date('2026-01-01T00:00:00.000Z'),
        },
        legs: [
          { accountId: ngn, amount: -1_500_000n },
          { accountId: poolNgn, amount: 1_500_000n },
          { accountId: poolUsd, amount: -1_000n },
          { accountId: usd, amount: 1_000n },
        ],
        activity: [
          {
            walletId,
            activityType: 'swap',
            currencyOut: 'cNGN',
            amountOut: 1_500_000n,
            currencyIn: 'USDx',
            amountIn: 1_000n,
          },
        ],
      }),
    );

    expect(result.balances.get(ngn)).toBe(0n);
    expect(result.balances.get(usd)).toBe(1_000n);
    expect(await count(t, 'ledger_entries')).toBe(4);
    expect(result.balances.has(poolNgn)).toBe(false);
  });

  it('round-trips a balance above 2^53 without losing precision', async () => {
    const walletId = await createWallet(t.pool);
    const account = await createUserAccount(t.pool, walletId, 'cNGN');
    const amount = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a JS number

    const result = await t.transactions.run(async (tx) =>
      t.ledger.post(tx, await depositInput(walletId, account, amount)),
    );
    expect(result.balances.get(account)).toBe(amount);
    expect(await balanceOf(t, account)).toBe(amount);
  });

  describe('programming-error guards', () => {
    async function expectInternalError(mutate: (input: PostInput) => void) {
      const walletId = await createWallet(t.pool);
      const account = await createUserAccount(t.pool, walletId, 'cNGN', 100n);
      const input = await depositInput(walletId, account, 10n);
      mutate(input);
      await expect(t.transactions.run((tx) => t.ledger.post(tx, input))).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect(await count(t, 'transactions')).toBe(0);
    }

    it('rejects a single-leg posting', () =>
      expectInternalError((input) => {
        input.legs = input.legs.slice(0, 1);
      }));

    it('rejects a zero-amount leg', () =>
      expectInternalError((input) => {
        input.legs = [...input.legs, { accountId: input.legs[0]?.accountId ?? '', amount: 0n }];
      }));

    it('rejects a leg that references an unknown account', () =>
      expectInternalError((input) => {
        input.legs = [
          { accountId: '00000000-0000-7000-8000-000000000000', amount: 10n },
          ...input.legs.slice(1),
        ];
      }));

    it('rejects a transaction header whose currency no leg moves', () =>
      expectInternalError((input) => {
        input.transaction.destCurrency = 'EURx';
      }));
  });
});
