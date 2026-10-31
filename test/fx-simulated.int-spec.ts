import { FxRefreshScheduler } from '../src/fx/fx-refresh.scheduler';
import { SimulatedFxProvider } from '../src/fx/simulated-fx-provider';
import { createTestApp, type TestApp } from './helpers/create-test-app';
import { seededRandom } from './helpers/seeded-random';

interface Pair {
  from: string;
  to: string;
  rate: string;
  refreshed_at?: string;
}

interface RatesBody {
  base: string;
  provider: string;
  source: string;
  as_of: string;
  refreshed_at: string;
  rates: Pair[];
}

describe('simulated rate feed', () => {
  let t: TestApp;
  let keyCounter = 0;

  beforeEach(async () => {
    jest.restoreAllMocks();
    t = await createTestApp({ fxProvider: 'simulated', random: seededRandom(42) });
    await t.reset(); // empty snapshot table, then the anchor is stored again
  });

  afterEach(async () => {
    await t.close();
  });

  const nextKey = () => `sim-key-${++keyCounter}`;

  const ratesBody = async (): Promise<RatesBody> =>
    (await t.agent.get('/v1/fx/rates').expect(200)).body as RatesBody;
  const pairRate = (pairs: Pair[], from: string, to: string): string =>
    pairs.find((p) => p.from === from && p.to === to)?.rate as string;

  async function snapshotRows() {
    const { rows } = await t.pool.query<{ source: string; rates: Record<string, string> }>(
      'SELECT source, rates FROM fx_rate_snapshots ORDER BY fetched_at, id',
    );
    return rows;
  }

  async function createWallet(email: string): Promise<string> {
    return (await t.agent.post('/v1/wallets').send({ email }).expect(201)).body.id as string;
  }

  describe('what clients see', () => {
    it('starts from the anchor rates, labelled with the simulated source', async () => {
      const body = await ratesBody();

      expect(body).toMatchObject({ base: 'USD', provider: 'simulated', source: 'simulated' });
      expect(body.rates).toHaveLength(20);
      expect(pairRate(body.rates, 'cNGN', 'cGHS')).toBe('0.010000000000'); // 15 / 1500 at the anchor
      const rows = await snapshotRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe('simulated');

      const ready = await t.agent.get('/health/ready').expect(200);
      expect(ready.body.checks.fx).toMatchObject({ provider: 'simulated', source: 'simulated' });
    });

    it('moves the rates on every refresh and persists each accepted step as a simulated snapshot', async () => {
      const before = await ratesBody();

      for (let i = 0; i < 5; i += 1) await t.rates.refresh();

      const after = await ratesBody();
      expect(after.rates).toHaveLength(20);
      expect(pairRate(after.rates, 'USDx', 'cNGN')).not.toBe(
        pairRate(before.rates, 'USDx', 'cNGN'),
      );
      expect(after.refreshed_at >= before.refreshed_at).toBe(true);
      const rows = await snapshotRows();
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.source === 'simulated')).toBe(true);
      for (const row of rows) expect(row.rates['USD']).toBe('1');
    });

    it('answers from the background job path too (the scheduler tick)', async () => {
      const before = pairRate((await ratesBody()).rates, 'USDx', 'EURx');

      await t.app.get(FxRefreshScheduler).tick();

      expect(pairRate((await ratesBody()).rates, 'USDx', 'EURx')).not.toBe(before);
      expect(await snapshotRows()).toHaveLength(2);
    });

    it('keeps every pair a valid 12-decimal rate and every step small over many refreshes', async () => {
      let previous = Number(pairRate((await ratesBody()).rates, 'USDx', 'cNGN'));
      for (let i = 0; i < 30; i += 1) {
        await t.rates.refresh();
        const body = await ratesBody();
        for (const pair of body.rates) {
          expect(pair.rate).toMatch(/^[0-9]{1,13}\.[0-9]{12}$/);
        }
        const current = Number(pairRate(body.rates, 'USDx', 'cNGN'));
        expect(Math.abs(current / previous - 1)).toBeLessThanOrEqual(0.015 + 2e-6);
        previous = current;
      }
    });
  });

  describe('conversions while the rates move', () => {
    it('a swap uses the rate that was current, records it as simulated and it reproduces the amount', async () => {
      const wallet = await createWallet('swap-sim@example.com');
      await t.agent
        .post(`/v1/wallets/${wallet}/deposits`)
        .set('Idempotency-Key', nextKey())
        .send({ currency: 'cNGN', amount: '5000' })
        .expect(201);

      const outcomes: { shown: string; recorded: string; source: string; ok: boolean }[] = [];
      for (let i = 0; i < 3; i += 1) {
        await t.rates.refresh();
        const shown = pairRate((await ratesBody()).rates, 'cNGN', 'USDx');
        const res = await t.agent
          .post(`/v1/wallets/${wallet}/swaps`)
          .set('Idempotency-Key', nextKey())
          .send({ from_currency: 'cNGN', to_currency: 'USDx', amount: '1000' })
          .expect(201);

        const row = await t.pool.query<{
          rate: string;
          source_amount: string;
          dest_amount: string;
        }>(
          'SELECT rate::text, source_amount::text, dest_amount::text FROM transactions WHERE id = $1',
          [res.body.transaction.id],
        );
        const tx = row.rows[0];
        const reproduced =
          (BigInt(tx?.source_amount ?? '0') * BigInt((tx?.rate ?? '').replace('.', ''))) /
          10n ** 12n;
        outcomes.push({
          shown,
          recorded: res.body.transaction.rate as string,
          source: res.body.transaction.rate_source as string,
          ok: reproduced.toString() === tx?.dest_amount && tx?.rate === shown,
        });
      }

      for (const outcome of outcomes) {
        expect(outcome.recorded).toBe(outcome.shown);
        expect(outcome.source).toBe('simulated');
        expect(outcome.ok).toBe(true);
      }
      // The three swaps really did price at different moments of a moving rate.
      expect(new Set(outcomes.map((o) => o.recorded)).size).toBeGreaterThan(1);
    });

    it('deposits and same-currency transfers keep working and never read a rate', async () => {
      const a = await createWallet('dep-a@example.com');
      const b = await createWallet('dep-b@example.com');
      const getRate = jest.spyOn(t.rates, 'getRate');
      await t.rates.refresh();

      await t.agent
        .post(`/v1/wallets/${a}/deposits`)
        .set('Idempotency-Key', nextKey())
        .send({ currency: 'cNGN', amount: '100' })
        .expect(201);
      await t.agent
        .post(`/v1/wallets/${a}/transfers`)
        .set('Idempotency-Key', nextKey())
        .send({ to_wallet_id: b, source_currency: 'cNGN', amount: '40' })
        .expect(201);

      expect(getRate).not.toHaveBeenCalled();
    });
  });

  describe('restarts', () => {
    it('continues from the last stored snapshot instead of snapping back to the anchor', async () => {
      for (let i = 0; i < 4; i += 1) await t.rates.refresh();
      const lastShown = await ratesBody();
      const anchorPair = '1500.000000000000'; // USDx -> cNGN at the anchor
      expect(pairRate(lastShown.rates, 'USDx', 'cNGN')).not.toBe(anchorPair);
      await t.close();

      // A new process on the same database: no reset.
      t = await createTestApp({ fxProvider: 'simulated', random: seededRandom(7) });
      const resumed = await ratesBody();

      expect(resumed.as_of).toBe(lastShown.as_of);
      expect(resumed.rates).toEqual(
        lastShown.rates.map((pair) => ({
          ...pair,
          refreshed_at: resumed.refreshed_at,
        })),
      );
      // ...and the walk goes on from there: the next step is a small move away, not from the anchor.
      await t.rates.refresh();
      const next = Number(pairRate((await ratesBody()).rates, 'USDx', 'cNGN'));
      const was = Number(pairRate(lastShown.rates, 'USDx', 'cNGN'));
      expect(Math.abs(next / was - 1)).toBeLessThanOrEqual(0.015 + 2e-6);
    });
  });

  describe('validation guard', () => {
    it('rejects a bad table from the feed: nothing stored, nothing changed, the error is reported', async () => {
      const before = await ratesBody();
      const rowsBefore = await snapshotRows();
      jest.spyOn(t.app.get(SimulatedFxProvider), 'fetchUsdRates').mockResolvedValueOnce({
        rates: { USD: '1', NGN: '0', GHS: '15', XAF: '600', EUR: '0.92' },
        providerUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(t.rates.refresh()).rejects.toMatchObject({ code: 'FX_UNAVAILABLE' });

      expect(await snapshotRows()).toEqual(rowsBefore);
      expect((await ratesBody()).rates).toEqual(before.rates);
      // Still ready: a failing feed never takes the service down. The reason is visible.
      const ready = await t.agent.get('/health/ready').expect(200);
      expect(ready.body.checks.fx.last_error).toMatch(/NGN/);

      // The next good refresh clears the error.
      await t.rates.refresh();
      const readyAgain = await t.agent.get('/health/ready').expect(200);
      expect(readyAgain.body.checks.fx).not.toHaveProperty('last_error');
    });

    it('rejects a wild jump even from a well-formed table', async () => {
      const before = await ratesBody();
      jest.spyOn(t.app.get(SimulatedFxProvider), 'fetchUsdRates').mockResolvedValueOnce({
        rates: { USD: '1', NGN: '2250', GHS: '15', XAF: '600', EUR: '0.92' }, // +50% on 1500
        providerUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(t.rates.refresh()).rejects.toMatchObject({ code: 'FX_UNAVAILABLE' });

      expect((await ratesBody()).rates).toEqual(before.rates);
    });
  });
});
