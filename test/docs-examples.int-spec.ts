import {
  DEPOSIT_EXAMPLE,
  HISTORY_EXAMPLE,
  QUOTE_EXAMPLE,
  RATES_EXAMPLE,
  RECONCILIATION_EXAMPLE,
  SWAP_EXAMPLE,
  TRANSACTION_DETAIL_EXAMPLE,
  TRANSFER_EXAMPLE,
  WALLET_EXAMPLE,
} from '../src/docs/examples';
import { createTestApp, type TestApp } from './helpers/create-test-app';

/** Key-level differences between an example and a real response (values are not compared). */
function sameKeys(example: unknown, actual: unknown, path = '$'): string[] {
  if (Array.isArray(example)) {
    if (!Array.isArray(actual) || example.length === 0 || actual.length === 0) return [];
    return sameKeys(example[0], actual[0], `${path}[]`);
  }
  if (example && typeof example === 'object') {
    if (!actual || typeof actual !== 'object') return [`${path}: expected an object`];
    const wanted = Object.keys(example).sort();
    const got = Object.keys(actual).sort();
    const problems: string[] = [];
    for (const key of wanted.filter((k) => !got.includes(k)))
      problems.push(`${path}.${key}: missing in the real response`);
    for (const key of got.filter((k) => !wanted.includes(k)))
      problems.push(`${path}.${key}: missing from the example`);
    for (const key of wanted.filter((k) => got.includes(k))) {
      problems.push(
        ...sameKeys(
          (example as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
          `${path}.${key}`,
        ),
      );
    }
    return problems;
  }
  return [];
}

describe('documented examples match real responses', () => {
  let t: TestApp;
  let keyCounter = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
  });

  const nextKey = () => `docs-key-${++keyCounter}`;

  it('wallet, deposit, swap, same- and cross-currency transfer, quote, rates, history, detail', async () => {
    const wallet = await t.agent
      .post('/v1/wallets')
      .send({ email: 'docs@example.com' })
      .expect(201);
    const other = await t.agent
      .post('/v1/wallets')
      .send({ email: 'docs2@example.com' })
      .expect(201);
    const id = wallet.body.id as string;
    const otherId = other.body.id as string;

    const deposit = await t.agent
      .post(`/v1/wallets/${id}/deposits`)
      .set('Idempotency-Key', nextKey())
      .send({ currency: 'cNGN', amount: '1000000' })
      .expect(201);
    const swap = await t.agent
      .post(`/v1/wallets/${id}/swaps`)
      .set('Idempotency-Key', nextKey())
      .send({ from_currency: 'cNGN', to_currency: 'USDx', amount: '100000' })
      .expect(201);
    const transfer = await t.agent
      .post(`/v1/wallets/${id}/transfers`)
      .set('Idempotency-Key', nextKey())
      .send({
        to_wallet_id: otherId,
        source_currency: 'cNGN',
        destination_currency: 'cGHS',
        amount: '50000',
      })
      .expect(201);
    const quote = await t.agent
      .post('/v1/fx/quotes')
      .send({ wallet_id: id, from_currency: 'cNGN', to_currency: 'USDx', amount: '1500' })
      .expect(201);
    const quoted = await t.agent
      .post(`/v1/wallets/${id}/swaps`)
      .set('Idempotency-Key', nextKey())
      .send({
        from_currency: 'cNGN',
        to_currency: 'USDx',
        amount: '1500',
        quote_id: quote.body.quote_id,
      })
      .expect(201);
    const rates = await t.agent.get('/v1/fx/rates').expect(200);
    const history = await t.agent.get(`/v1/wallets/${id}/transactions?limit=1`).expect(200);
    const detail = await t.agent.get(`/v1/transactions/${swap.body.transaction.id}`).expect(200);
    const fetched = await t.agent.get(`/v1/wallets/${id}`).expect(200);

    expect(sameKeys(WALLET_EXAMPLE, wallet.body)).toEqual([]);
    expect(sameKeys(WALLET_EXAMPLE, fetched.body)).toEqual([]);
    expect(sameKeys(DEPOSIT_EXAMPLE, deposit.body)).toEqual([]);
    expect(sameKeys(SWAP_EXAMPLE, swap.body)).toEqual([]);
    expect(sameKeys(TRANSFER_EXAMPLE, transfer.body)).toEqual([]);
    expect(sameKeys(QUOTE_EXAMPLE, quote.body)).toEqual([]);
    // A swap that used a quote adds quote_id; nothing else differs.
    expect(
      sameKeys({ ...SWAP_EXAMPLE.transaction, quote_id: 'x' }, quoted.body.transaction),
    ).toEqual([]);
    expect(sameKeys(RATES_EXAMPLE, rates.body)).toEqual([]);
    expect(sameKeys(HISTORY_EXAMPLE, history.body)).toEqual([]);
    expect(sameKeys(TRANSACTION_DETAIL_EXAMPLE, detail.body)).toEqual([]);
  });

  it('reconciliation run and the problem body', async () => {
    const run = await t.agent.post('/v1/admin/reconciliation/run').expect(200);
    const problem = await t.agent
      .get('/v1/wallets/019a1c52-3f10-7a31-8d52-0c4e6f1b2a90')
      .expect(404);

    expect(sameKeys(RECONCILIATION_EXAMPLE, run.body)).toEqual([]);
    expect(Object.keys(problem.body as object).sort()).toEqual(
      ['code', 'detail', 'request_id', 'status', 'title', 'type'].sort(),
    );
  });
});
