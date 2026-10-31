import { AppError } from '../src/common/errors/app-error';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { guardRatesOutsideTransactions } from './helpers/rate-guard';

interface QuoteBody {
  quote_id: string;
  rate: string;
  source_amount: string;
  destination_amount: string;
  source: string;
  expires_at: string;
}

describe('expiring single-use quotes', () => {
  let t: TestApp;
  let walletId: string;
  let otherWalletId: string;
  let keyCounter = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    walletId = (await t.agent.post('/v1/wallets').send({ email: 'q1@example.com' }).expect(201))
      .body.id as string;
    otherWalletId = (
      await t.agent.post('/v1/wallets').send({ email: 'q2@example.com' }).expect(201)
    ).body.id as string;
  });

  const nextKey = () => `quote-key-${++keyCounter}`;

  const deposit = (id: string, currency: string, amount: string) =>
    t.agent
      .post(`/v1/wallets/${id}/deposits`)
      .set('Idempotency-Key', nextKey())
      .send({ currency, amount })
      .expect(201);

  const createQuote = (body: Record<string, unknown> = {}) =>
    t.agent.post('/v1/fx/quotes').send({
      wallet_id: walletId,
      from_currency: 'cNGN',
      to_currency: 'USDx',
      amount: '1500',
      ...body,
    });

  const quoted = async (body: Record<string, unknown> = {}): Promise<QuoteBody> =>
    (await createQuote(body).expect(201)).body as QuoteBody;

  const swapWith = (quoteId: string | undefined, key = nextKey(), body: object = {}) =>
    t.agent
      .post(`/v1/wallets/${walletId}/swaps`)
      .set('Idempotency-Key', key)
      .send({
        from_currency: 'cNGN',
        to_currency: 'USDx',
        amount: '1500',
        ...(quoteId ? { quote_id: quoteId } : {}),
        ...body,
      });

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await t.pool.query<{ v: T }>(sql, params);
    return rows[0]?.v as T;
  }

  async function expectLedgerBalanced(): Promise<void> {
    const sums = await t.pool.query<{ sum: string }>(
      'SELECT sum(amount)::text AS sum FROM ledger_entries GROUP BY currency',
    );
    for (const row of sums.rows) expect(row.sum).toBe('0');
  }

  const usedAt = (id: string) =>
    scalar<Date | null>('SELECT used_at AS v FROM fx_quotes WHERE id = $1', [id]);

  describe('creating a quote', () => {
    it('locks the rate for 30 seconds from the clock and prices the destination', async () => {
      const quote = await createQuote().expect(201);

      expect(quote.headers['location']).toBe(`/v1/fx/quotes/${quote.body.quote_id}`);
      expect(quote.body).toMatchObject({
        rate: '0.000666666666',
        source_amount: '1500.000000',
        destination_amount: '0.999999',
        source: 'static',
        expires_at: new Date(t.clock.now().getTime() + 30_000).toISOString(),
      });
    });

    it('rejects dust with 422 AMOUNT_TOO_SMALL and stores nothing', async () => {
      const res = await createQuote({ amount: '0.000001' }).expect(422);

      expect(res.body.code).toBe('AMOUNT_TOO_SMALL');
      expect(await scalar<number>('SELECT count(*)::int AS v FROM fx_quotes')).toBe(0);
    });

    it('rejects an unknown wallet, the same currency, an unknown coin and a bad amount', async () => {
      const unknown = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
      expect((await createQuote({ wallet_id: unknown }).expect(404)).body.code).toBe(
        'WALLET_NOT_FOUND',
      );
      expect((await createQuote({ to_currency: 'cNGN' }).expect(400)).body.code).toBe(
        'SAME_CURRENCY_SWAP',
      );
      expect((await createQuote({ to_currency: 'BTC' }).expect(400)).body.code).toBe(
        'UNSUPPORTED_CURRENCY',
      );
      expect((await createQuote({ amount: '1e3' }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    });

    it('is a 503 with Retry-After when no rates are loaded', async () => {
      jest.spyOn(t.rates, 'getRate').mockImplementation(() => {
        throw new AppError('FX_UNAVAILABLE', { retryAfterSeconds: 1 });
      });

      const res = await createQuote().expect(503);

      expect(res.body.code).toBe('FX_UNAVAILABLE');
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('executing a swap against a quote', () => {
    it('executes at the quoted rate, not the current one, and records rate_source quote', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      // The market moves after the quote was issued.
      jest.spyOn(t.rates, 'getRate').mockReturnValue({
        rate: '0.000500000000',
        source: 'static',
        asOf: t.clock.now(),
      });

      const res = await swapWith(quote.quote_id).expect(201);

      expect(res.body.transaction).toMatchObject({
        rate: '0.000666666666',
        rate_source: 'quote',
        dest_amount: '0.999999',
        quote_id: quote.quote_id,
      });
      const stored = await t.pool.query<{ rate_source: string; quote_id: string }>(
        'SELECT rate_source, quote_id FROM transactions WHERE id = $1',
        [res.body.transaction.id],
      );
      expect(stored.rows[0]).toEqual({ rate_source: 'quote', quote_id: quote.quote_id });
      expect(await usedAt(quote.quote_id)).not.toBeNull();
      await expectLedgerBalanced();
    });

    it('does not read a rate inside a transaction when a quote is used', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      const guard = guardRatesOutsideTransactions(t);

      await swapWith(quote.quote_id).expect(201);

      expect(guard.rateCalls).toBe(0);
      guard.restore();
    });

    it('rejects a quote used after it expired with 422 QUOTE_EXPIRED, at the boundary and beyond', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const atBoundary = await quoted();
      const late = await quoted();

      t.clock.advance(30_000);
      expect((await swapWith(atBoundary.quote_id).expect(422)).body.code).toBe('QUOTE_EXPIRED');
      t.clock.advance(1_000);
      expect((await swapWith(late.quote_id).expect(422)).body.code).toBe('QUOTE_EXPIRED');
      expect(await usedAt(late.quote_id)).toBeNull();
    });

    it('is still usable one millisecond before it expires', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();

      t.clock.advance(29_999);

      await swapWith(quote.quote_id).expect(201);
    });

    it('rejects a second use with a new key as 422 QUOTE_USED', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      await swapWith(quote.quote_id).expect(201);

      const second = await swapWith(quote.quote_id).expect(422);

      expect(second.body.code).toBe('QUOTE_USED');
      expect(
        await scalar<number>("SELECT count(*)::int AS v FROM transactions WHERE type = 'swap'"),
      ).toBe(1);
    });

    it('rejects a different amount, a different pair and another wallet as 422 QUOTE_MISMATCH', async () => {
      await deposit(walletId, 'cNGN', '3000');
      await deposit(otherWalletId, 'cNGN', '3000');
      const quote = await quoted();

      const amount = await swapWith(quote.quote_id, nextKey(), { amount: '1000' }).expect(422);
      const pair = await swapWith(quote.quote_id, nextKey(), { to_currency: 'EURx' }).expect(422);
      const other = await t.agent
        .post(`/v1/wallets/${otherWalletId}/swaps`)
        .set('Idempotency-Key', nextKey())
        .send({
          from_currency: 'cNGN',
          to_currency: 'USDx',
          amount: '1500',
          quote_id: quote.quote_id,
        })
        .expect(422);

      for (const res of [amount, pair, other]) expect(res.body.code).toBe('QUOTE_MISMATCH');
      // None of those attempts burned the quote.
      expect(await usedAt(quote.quote_id)).toBeNull();
      await swapWith(quote.quote_id).expect(201);
    });

    it('answers an unknown quote with 404 and leaves the idempotency key free', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const key = nextKey();
      const unknown = '01a18e56-7952-729f-ab7d-cb9426c0fd98';

      const res = await swapWith(unknown, key).expect(404);

      expect(res.body.code).toBe('QUOTE_NOT_FOUND');
      const quote = await quoted();
      await swapWith(quote.quote_id, key).expect(201);
    });

    it('replays a quoted swap with the same key as the original 201, not QUOTE_USED', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      const key = nextKey();
      const first = await swapWith(quote.quote_id, key).expect(201);

      const replay = await swapWith(quote.quote_id, key).expect(201);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.text).toBe(first.text);
      expect(
        await scalar<number>("SELECT count(*)::int AS v FROM transactions WHERE type = 'swap'"),
      ).toBe(1);
    });

    it('treats the same key with a different quote as a reused key', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const a = await quoted();
      const b = await quoted();
      const key = nextKey();
      await swapWith(a.quote_id, key).expect(201);

      const res = await swapWith(b.quote_id, key).expect(422);

      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await usedAt(b.quote_id)).toBeNull();
    });

    it('lets exactly one of two simultaneous swaps on one quote succeed', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();

      const results = await Promise.all([
        swapWith(quote.quote_id, nextKey()),
        swapWith(quote.quote_id, nextKey()),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 422]);
      const loser = results.find((r) => r.status === 422);
      expect(loser?.body.code).toBe('QUOTE_USED');
      expect(
        await scalar<number>("SELECT count(*)::int AS v FROM transactions WHERE type = 'swap'"),
      ).toBe(1);
      await expectLedgerBalanced();
    });

    it('does not burn the quote when the swap itself fails for insufficient funds', async () => {
      await deposit(walletId, 'cNGN', '100');
      const quote = await quoted();

      const failed = await swapWith(quote.quote_id).expect(422);

      expect(failed.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(await usedAt(quote.quote_id)).toBeNull();
      await deposit(walletId, 'cNGN', '5000');
      await swapWith(quote.quote_id).expect(201);
    });

    it('rejects a malformed quote_id and a null one with 400', async () => {
      await deposit(walletId, 'cNGN', '3000');

      expect((await swapWith('not-a-uuid').expect(400)).body.code).toBe('VALIDATION_ERROR');
      expect(
        (
          await t.agent
            .post(`/v1/wallets/${walletId}/swaps`)
            .set('Idempotency-Key', nextKey())
            .send({ from_currency: 'cNGN', to_currency: 'USDx', amount: '1', quote_id: null })
            .expect(400)
        ).body.code,
      ).toBe('VALIDATION_ERROR');
    });
  });

  describe('executing a cross-currency transfer against a quote', () => {
    const transferWith = (quoteId: string, body: object = {}, key = nextKey()) =>
      t.agent
        .post(`/v1/wallets/${walletId}/transfers`)
        .set('Idempotency-Key', key)
        .send({
          to_wallet_id: otherWalletId,
          source_currency: 'cNGN',
          destination_currency: 'USDx',
          amount: '1500',
          quote_id: quoteId,
          ...body,
        });

    it('credits the recipient at the quoted rate and records rate_source quote', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();

      const res = await transferWith(quote.quote_id).expect(201);

      expect(res.body.transaction).toMatchObject({
        rate: '0.000666666666',
        rate_source: 'quote',
        dest_amount: '0.999999',
        quote_id: quote.quote_id,
      });
      await expectLedgerBalanced();
      expect((await transferWith(quote.quote_id).expect(422)).body.code).toBe('QUOTE_USED');
    });

    it('rejects a quote for a same-currency transfer with 400 before anything is stored', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();

      const res = await transferWith(quote.quote_id, { destination_currency: 'cNGN' }).expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await usedAt(quote.quote_id)).toBeNull();
    });
  });

  describe('retries, case and failures', () => {
    it('accepts an upper-case quote_id and replays it under the same key written in lower case', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      const key = nextKey();
      const first = await swapWith(quote.quote_id.toUpperCase(), key).expect(201);

      const replay = await swapWith(quote.quote_id, key).expect(201);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.text).toBe(first.text);
    });

    it('replays a stored QUOTE_USED under the same key even after the quote could not be used anyway', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      await swapWith(quote.quote_id).expect(201);
      const key = nextKey();
      const rejected = await swapWith(quote.quote_id, key).expect(422);

      t.clock.advance(60_000);
      const replay = await swapWith(quote.quote_id, key).expect(422);

      expect(rejected.body.code).toBe('QUOTE_USED');
      expect(replay.body.code).toBe('QUOTE_USED');
      expect(replay.headers['idempotent-replayed']).toBe('true');
    });

    it('keeps the quote when the paying wallet is frozen', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      await t.pool.query("UPDATE wallets SET status = 'frozen' WHERE id = $1", [walletId]);

      const res = await swapWith(quote.quote_id).expect(422);

      expect(res.body.code).toBe('WALLET_FROZEN');
      expect(await usedAt(quote.quote_id)).toBeNull();
    });

    it('lets only one of two simultaneous requests with the same key and quote create a swap', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      const key = nextKey();

      const results = await Promise.all([
        swapWith(quote.quote_id, key),
        swapWith(quote.quote_id, key),
      ]);

      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(results[0]?.text).toBe(results[1]?.text);
      expect(
        await scalar<number>("SELECT count(*)::int AS v FROM transactions WHERE type = 'swap'"),
      ).toBe(1);
    });

    it('cannot record two transactions for one quote, even by writing to the table directly', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      await swapWith(quote.quote_id).expect(201);

      await expect(
        t.pool.query(
          `INSERT INTO transactions (id, type, source_currency, source_amount, dest_currency, dest_amount, quote_id, initiator_wallet_id)
           VALUES ('01a18e56-7952-729f-ab7d-cb9426c0fd01', 'swap', 'cNGN', 1, 'USDx', 1, $1, $2)`,
          [quote.quote_id, walletId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('more transfer cases', () => {
    const transferFrom = (from: string, quoteId: string, key = nextKey(), body: object = {}) =>
      t.agent
        .post(`/v1/wallets/${from}/transfers`)
        .set('Idempotency-Key', key)
        .send({
          to_wallet_id: from === walletId ? otherWalletId : walletId,
          source_currency: 'cNGN',
          destination_currency: 'USDx',
          amount: '1500',
          quote_id: quoteId,
          ...body,
        });

    it('replays a quoted transfer with the same key, not QUOTE_USED', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const quote = await quoted();
      const key = nextKey();
      const first = await transferFrom(walletId, quote.quote_id, key).expect(201);

      const replay = await transferFrom(walletId, quote.quote_id, key).expect(201);

      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.text).toBe(first.text);
    });

    it('answers an unknown quote with 404 and an unknown recipient with 404 first', async () => {
      await deposit(walletId, 'cNGN', '3000');
      const unknown = '01a18e56-7952-729f-ab7d-cb9426c0fd98';

      const noQuote = await transferFrom(walletId, unknown).expect(404);
      const noRecipient = await transferFrom(walletId, unknown, nextKey(), {
        to_wallet_id: unknown,
      }).expect(404);

      expect(noQuote.body.code).toBe('QUOTE_NOT_FOUND');
      expect(noRecipient.body.code).toBe('RECIPIENT_NOT_FOUND');
    });

    it('rejects a quote issued to another wallet, an expired one, and keeps it on insufficient funds', async () => {
      await deposit(walletId, 'cNGN', '3000');
      await deposit(otherWalletId, 'cNGN', '100');
      const theirs = await quoted();
      const mismatch = await transferFrom(otherWalletId, theirs.quote_id).expect(422);
      expect(mismatch.body.code).toBe('QUOTE_MISMATCH');

      const poor = await quoted({ wallet_id: otherWalletId });
      const broke = await transferFrom(otherWalletId, poor.quote_id).expect(422);
      expect(broke.body.code).toBe('INSUFFICIENT_FUNDS');
      expect(await usedAt(poor.quote_id)).toBeNull();

      t.clock.advance(31_000);
      const late = await transferFrom(otherWalletId, poor.quote_id).expect(422);
      expect(late.body.code).toBe('QUOTE_EXPIRED');
    });
  });

  describe('a quote and the market', () => {
    it('keeps a swap without a quote priced from the live rate, unchanged', async () => {
      await deposit(walletId, 'cNGN', '3000');

      const res = await swapWith(undefined).expect(201);

      expect(res.body.transaction.rate_source).toBe('static');
      expect(res.body.transaction).not.toHaveProperty('quote_id');
    });
  });
});
