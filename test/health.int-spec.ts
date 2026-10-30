import { createTestApp, type TestApp } from './helpers/create-test-app';

describe('health', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('GET /health/live returns 200', async () => {
    const res = await t.agent.get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns 200 with the database check up', async () => {
    const res = await t.agent.get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
  });
});
