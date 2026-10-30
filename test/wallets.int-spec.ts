import { createTestApp, type TestApp } from './helpers/create-test-app';

describe('wallets', () => {
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

  async function count(table: string): Promise<number> {
    const { rows } = await t.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? -1;
  }

  it('creates a wallet with an email: 201, Location and five zero balances', async () => {
    const res = await t.agent.post('/v1/wallets').send({ email: 'ada@example.com' }).expect(201);

    expect(res.headers['location']).toBe(`/v1/wallets/${res.body.id}`);
    expect(res.body).toMatchObject({
      email: 'ada@example.com',
      phone: null,
      status: 'active',
      balances: [
        { currency: 'cNGN', amount: '0.000000' },
        { currency: 'cGHS', amount: '0.000000' },
        { currency: 'cXAF', amount: '0.000000' },
        { currency: 'USDx', amount: '0.000000' },
        { currency: 'EURx', amount: '0.000000' },
      ],
    });
    expect(typeof res.body.created_at).toBe('string');
    expect(await count("accounts WHERE kind = 'user'")).toBe(5);
  });

  it('stores a Nigerian phone number as E.164', async () => {
    const res = await t.agent.post('/v1/wallets').send({ phone: '08031234567' }).expect(201);
    expect(res.body.phone).toBe('+2348031234567');
    expect(res.body.email).toBeNull();
  });

  it('rejects a body with neither email nor phone', async () => {
    const res = await t.agent.post('/v1/wallets').send({}).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await count('wallets')).toBe(0);
  });

  it('accepts both an email and a phone', async () => {
    await t.agent
      .post('/v1/wallets')
      .send({ email: 'both@example.com', phone: '+233201234567' })
      .expect(201);
  });

  it('rejects an invalid email or phone with VALIDATION_ERROR', async () => {
    await t.agent.post('/v1/wallets').send({ email: 'not-an-email' }).expect(400);
    await t.agent.post('/v1/wallets').send({ phone: '123' }).expect(400);
  });

  it('rejects an unknown body field', async () => {
    const res = await t.agent
      .post('/v1/wallets')
      .send({ email: 'x@example.com', role: 'admin' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a second wallet with the same email, ignoring case and surrounding spaces', async () => {
    await t.agent.post('/v1/wallets').send({ email: 'A@X.com' }).expect(201);
    const res = await t.agent.post('/v1/wallets').send({ email: 'a@x.com ' }).expect(409);
    expect(res.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    expect(JSON.stringify(res.body)).not.toContain('a@x.com');
    expect(await count('wallets')).toBe(1);
  });

  it('rejects a second wallet with the same phone written differently', async () => {
    await t.agent.post('/v1/wallets').send({ phone: '08031234567' }).expect(201);
    await t.agent.post('/v1/wallets').send({ phone: '+234 803 123 4567' }).expect(409);
  });

  it('keeps plus-tags distinct', async () => {
    await t.agent.post('/v1/wallets').send({ email: 'a+one@x.com' }).expect(201);
    await t.agent.post('/v1/wallets').send({ email: 'a+two@x.com' }).expect(201);
  });

  it('lets exactly one of five simultaneous creates with the same email win', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.agent.post('/v1/wallets').send({ email: 'race@example.com' }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await count('wallets')).toBe(1);
    expect(await count("accounts WHERE kind = 'user'")).toBe(5);
  });

  it.each([
    [{ email: null }],
    [{ phone: null }],
    [{ email: 'a@x.com', phone: null }],
    [{ email: 42 }],
    [{ phone: ['08031234567'] }],
    [{ email: { address: 'a@x.com' } }],
  ])('rejects non-string identifiers with 400, not 500: %j', async (body) => {
    const res = await t.agent.post('/v1/wallets').send(body).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await count('wallets')).toBe(0);
  });

  it('reads a wallet back', async () => {
    const created = await t.agent
      .post('/v1/wallets')
      .send({ email: 'read@example.com' })
      .expect(201);
    const res = await t.agent.get(`/v1/wallets/${created.body.id}`).expect(200);
    expect(res.body).toEqual(created.body);
  });

  it('answers a malformed id with 400 and an unknown id with 404', async () => {
    const bad = await t.agent.get('/v1/wallets/not-a-uuid').expect(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    const unknown = await t.agent
      .get('/v1/wallets/01a18e56-7952-729f-ab7d-cb9426c0fd98')
      .expect(404);
    expect(unknown.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });
});
