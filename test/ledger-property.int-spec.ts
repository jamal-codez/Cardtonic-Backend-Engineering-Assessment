import fc from 'fast-check';
import { ReconciliationService } from '../src/ledger/reconciliation.service';
import { isSkipped } from '../src/ledger/reconciliation.types';
import { createTestApp, type TestApp } from './helpers/create-test-app';

const CURRENCIES = ['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx', 'cngn', 'usdx'] as const;
const INITIAL_WALLETS = 4;

type Op =
  | { kind: 'create'; with: 'email' | 'phone' | 'both' | 'none' }
  | { kind: 'deposit'; wallet: number; currency: number; amount: string; replay: boolean }
  | { kind: 'swap'; wallet: number; from: number; to: number; amount: string; replay: boolean }
  | {
      kind: 'transfer';
      from: number;
      to: number;
      currency: number;
      destination: number | null;
      amount: string;
      replay: boolean;
    };

const validAmount = fc
  .tuple(fc.integer({ min: 0, max: 800 }), fc.option(fc.integer({ min: 0, max: 999_999 })))
  .map(([whole, fraction]) =>
    fraction === null ? `${whole}` : `${whole}.${fraction.toString().padStart(6, '0')}`,
  );
const invalidAmount = fc.constantFrom(
  '-1',
  'abc',
  '1e3',
  '',
  ' 5',
  '1.0000001',
  '1000000001',
  '0x10',
);
const amount = fc.oneof(
  { weight: 8, arbitrary: validAmount },
  { weight: 1, arbitrary: invalidAmount },
);
const index = fc.integer({ min: 0, max: 11 });
const currency = fc.integer({ min: 0, max: CURRENCIES.length - 1 });

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('email', 'phone', 'both', 'none')
      .map((w): Op => ({ kind: 'create', with: w })),
  },
  {
    weight: 6,
    arbitrary: fc
      .record({
        wallet: index,
        currency,
        amount,
        replay: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
      })
      .map((r): Op => ({ kind: 'deposit', ...r })),
  },
  {
    weight: 5,
    arbitrary: fc
      .record({
        wallet: index,
        from: currency,
        to: currency,
        amount,
        replay: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
      })
      .map((r): Op => ({ kind: 'swap', ...r })),
  },
  {
    weight: 6,
    arbitrary: fc
      .record({
        from: index,
        to: fc.integer({ min: -1, max: 11 }),
        currency,
        destination: fc.option(currency, { nil: null }),
        amount,
        replay: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
      })
      .map((r): Op => ({ kind: 'transfer', ...r })),
  },
);

describe('ledger property: any sequence of operations reconciles', () => {
  let t: TestApp;
  let service: ReconciliationService;

  beforeAll(async () => {
    t = await createTestApp();
    service = t.app.get(ReconciliationService);
  });

  afterAll(async () => {
    await t.close();
  });

  it('300 random operations (valid and invalid) leave a ledger that reconciles with no negative balance', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 300, maxLength: 300 }), async (ops) => {
        await t.reset();
        const wallets: string[] = [];
        const createWallet = async (email: string | undefined, phone: string | undefined) => {
          const res = await t.agent.post('/v1/wallets').send({ email, phone });
          if (res.status === 201) wallets.push(res.body.id as string);
          return res;
        };
        for (let i = 0; i < INITIAL_WALLETS; i += 1)
          await createWallet(`p${i}@example.com`, undefined);
        expect(wallets).toHaveLength(INITIAL_WALLETS);
        // Fund every wallet so that swaps and transfers have something to move.
        for (const [w, id] of wallets.entries()) {
          for (const coin of ['cNGN', 'cGHS', 'cXAF', 'USDx', 'EURx']) {
            const funded = await t.agent
              .post(`/v1/wallets/${id}/deposits`)
              .set('Idempotency-Key', `fund-${w}-${coin}`)
              .send({ currency: coin, amount: '5000' });
            expect(funded.status).toBe(201);
          }
        }

        const pick = (i: number) => wallets[i % wallets.length] as string;
        const ghost = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
        let counter = 0;
        let last: { path: string; key: string; body: object } | undefined;

        for (const o of ops) {
          let status: number;
          if (o.kind === 'create') {
            counter += 1;
            const email =
              o.with === 'email' || o.with === 'both' ? `n${counter}@example.com` : undefined;
            const phone =
              o.with === 'phone' || o.with === 'both'
                ? `0803${String(1_000_000 + counter)}`
                : undefined;
            status = (await createWallet(email, phone)).status;
          } else {
            let request: { path: string; key: string; body: object };
            if (o.replay && last) {
              request = last; // same key, same body: must replay, never double-apply
            } else {
              counter += 1;
              if (o.kind === 'deposit') {
                request = {
                  path: `/v1/wallets/${pick(o.wallet)}/deposits`,
                  key: `prop-${counter}`,
                  body: { currency: CURRENCIES[o.currency], amount: o.amount },
                };
              } else if (o.kind === 'swap') {
                request = {
                  path: `/v1/wallets/${pick(o.wallet)}/swaps`,
                  key: `prop-${counter}`,
                  body: {
                    from_currency: CURRENCIES[o.from],
                    to_currency: CURRENCIES[o.to],
                    amount: o.amount,
                  },
                };
              } else {
                request = {
                  path: `/v1/wallets/${pick(o.from)}/transfers`,
                  key: `prop-${counter}`,
                  body: {
                    to_wallet_id: o.to < 0 ? ghost : pick(o.to),
                    source_currency: CURRENCIES[o.currency],
                    ...(o.destination === null
                      ? {}
                      : { destination_currency: CURRENCIES[o.destination] }),
                    amount: o.amount,
                  },
                };
              }
              last = request;
            }
            const res = await t.agent
              .post(request.path)
              .set('Idempotency-Key', request.key)
              .send(request.body);
            status = res.status;
          }
          // Valid and invalid requests alike: the API may refuse, but it must never fail.
          expect(status).toBeLessThan(500);
        }

        const result = await service.run('full');
        if (isSkipped(result)) throw new Error('reconciliation was skipped');
        expect(result).toMatchObject({ ok: true, drift: [], unbalancedTx: [] });
        expect(Object.values(result.currencyNet).every((net) => net === '0.000000')).toBe(true);

        // The run was not vacuous: swaps and transfers really happened.
        const counts = await t.pool.query<{ type: string; n: number }>(
          'SELECT type, count(*)::int AS n FROM transactions GROUP BY type',
        );
        const byType = Object.fromEntries(counts.rows.map((r) => [r.type, r.n]));
        expect(byType['swap']).toBeGreaterThan(5);
        expect(byType['transfer']).toBeGreaterThan(5);
        expect(byType['deposit']).toBeGreaterThan(INITIAL_WALLETS * 5);

        const { rows } = await t.pool.query<{ lowest: string | null }>(
          `SELECT min(balance)::text AS lowest FROM accounts WHERE kind = 'user'`,
        );
        expect(BigInt(rows[0]?.lowest ?? '0') >= 0n).toBe(true);
      }),
      { seed: 20_260_730, numRuns: 1, endOnFailure: true },
    );
  }, 280_000);
});
