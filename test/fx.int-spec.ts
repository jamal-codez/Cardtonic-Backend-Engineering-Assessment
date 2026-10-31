import { Pool } from 'pg';
import { createTestApp, type TestApp } from './helpers/create-test-app';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('fx boot and snapshots', () => {
  let pool: Pool;
  let t: TestApp | undefined;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DB_URL, max: 3 });
  });

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function snapshots() {
    const { rows } = await pool.query<{ source: string; rates: Record<string, string> }>(
      'SELECT source, rates FROM fx_rate_snapshots',
    );
    return rows;
  }

  it('persists a static snapshot when it boots with an empty snapshot table', async () => {
    await pool.query('TRUNCATE fx_rate_snapshots');

    t = await createTestApp();

    const rows = await snapshots();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('static');
    expect(rows[0]?.rates).toMatchObject({
      USD: '1',
      NGN: '1500',
      GHS: '15',
      XAF: '600',
      EUR: '0.92',
    });
    const res = await t.agent.get('/v1/fx/rates').expect(200);
    expect(res.body.source).toBe('static');
  });

  it('uses an existing snapshot at boot and writes no new row', async () => {
    await pool.query('TRUNCATE fx_rate_snapshots');
    await pool.query(
      `INSERT INTO fx_rate_snapshots (id, base, rates, source, provider_updated_at)
       VALUES ('01a18e56-7952-729f-ab7d-cb9426c0fd98', 'USD', $1, 'static', '2026-02-02T10:00:00.000Z')`,
      [JSON.stringify({ USD: '1', NGN: '1600', GHS: '15', XAF: '600', EUR: '0.92' })],
    );

    t = await createTestApp();

    expect(await snapshots()).toHaveLength(1);
    const res = await t.agent.get('/v1/fx/rates').expect(200);
    expect(res.body.as_of).toBe('2026-02-02T10:00:00.000Z');
    const ngnToUsd = res.body.rates.find(
      (r: { from: string; to: string }) => r.from === 'cNGN' && r.to === 'USDx',
    );
    expect(ngnToUsd.rate).toBe('0.000625000000');
  });

  it('skips an unreadable newest row at boot and uses the newest readable one', async () => {
    await pool.query('TRUNCATE fx_rate_snapshots');
    await pool.query(
      `INSERT INTO fx_rate_snapshots (id, base, rates, source, provider_updated_at, fetched_at)
       VALUES ('01a18e56-0000-729f-ab7d-cb9426c0fd98', 'USD', $1, 'static', '2026-02-02T10:00:00.000Z', now() - interval '1 hour')`,
      [JSON.stringify({ USD: '1', NGN: '1600', GHS: '15', XAF: '600', EUR: '0.92' })],
    );
    await pool.query(
      `INSERT INTO fx_rate_snapshots (id, base, rates, source, provider_updated_at, fetched_at)
       VALUES ('01a18e56-0001-729f-ab7d-cb9426c0fd98', 'USD', '{"USD":"2"}', 'static', now(), now())`,
    );

    t = await createTestApp();

    expect(await snapshots()).toHaveLength(2); // nothing new was written
    const res = await t.agent.get('/v1/fx/rates').expect(200);
    expect(res.body.as_of).toBe('2026-02-02T10:00:00.000Z');
  });

  it('refresh() persists a new snapshot row and keeps serving rates', async () => {
    await pool.query('TRUNCATE fx_rate_snapshots');
    t = await createTestApp();
    expect(await snapshots()).toHaveLength(1);

    await t.rates.refresh();

    expect(await snapshots()).toHaveLength(2);
    await t.agent.get('/v1/fx/rates').expect(200);
  });
});

describe('GET /v1/fx/rates', () => {
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

  it('returns all 20 non-identity pairs, ordered, with 12-decimal rates and ISO timestamps', async () => {
    const res = await t.agent.get('/v1/fx/rates').expect(200);

    expect(res.body).toMatchObject({ base: 'USD', source: 'static' });
    expect(res.body.as_of).toMatch(ISO);
    expect(res.body.refreshed_at).toMatch(ISO);
    expect(res.body.rates).toHaveLength(20);
    expect(res.body.rates[0]).toEqual({
      from: 'cNGN',
      to: 'cGHS',
      rate: '0.010000000000',
      source: 'static',
      refreshed_at: res.body.refreshed_at,
    });
    for (const pair of res.body.rates) {
      expect(pair.from).not.toBe(pair.to);
      expect(pair.rate).toMatch(/^[0-9]+\.[0-9]{12}$/);
      expect(pair.refreshed_at).toMatch(ISO);
    }
    const order = res.body.rates.map((r: { from: string; to: string }) => `${r.from}>${r.to}`);
    expect(new Set(order).size).toBe(20);
  });

  it('is served without an idempotency key or authentication', async () => {
    await t.agent.get('/v1/fx/rates').expect(200);
  });
});

describe('total_usd on a wallet', () => {
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

  it('is an indicative zero for a new wallet', async () => {
    const created = await t.agent
      .post('/v1/wallets')
      .send({ email: 'fx0@example.com' })
      .expect(201);
    expect(created.body.total_usd).toMatchObject({ amount: '0.00', indicative: true });
    const res = await t.agent.get(`/v1/wallets/${created.body.id}`).expect(200);
    expect(res.body.total_usd).toEqual({
      amount: '0.00',
      rates_as_of: expect.stringMatching(ISO),
      source: 'static',
      indicative: true,
    });
  });

  it('values deposits in USD, rounded down, and says it is indicative', async () => {
    const created = await t.agent
      .post('/v1/wallets')
      .send({ email: 'fx1@example.com' })
      .expect(201);
    const id = created.body.id as string;
    await t.agent
      .post(`/v1/wallets/${id}/deposits`)
      .set('Idempotency-Key', 'fx-usd')
      .send({ currency: 'USDx', amount: '10' })
      .expect(201);
    await t.agent
      .post(`/v1/wallets/${id}/deposits`)
      .set('Idempotency-Key', 'fx-ngn')
      .send({ currency: 'cNGN', amount: '1500' })
      .expect(201);

    const res = await t.agent.get(`/v1/wallets/${id}`).expect(200);

    // 10 USD at par plus 1500 cNGN at the recorded (rounded down) rate 0.000666666666.
    expect(res.body.total_usd.amount).toBe('10.99');
    expect(res.body.total_usd).toMatchObject({ indicative: true, source: 'static' });
    expect(res.body.balances.map((b: { amount: string }) => b.amount)).toEqual([
      '1500.000000',
      '0.000000',
      '0.000000',
      '10.000000',
      '0.000000',
    ]);
  });
});
