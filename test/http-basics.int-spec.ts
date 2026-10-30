import { createTestApp, type TestApp } from './helpers/create-test-app';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('http basics', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('answers an unknown route with a 404 problem+json', async () => {
    const res = await t.agent.get('/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(res.body).toHaveProperty('request_id');
  });

  it('echoes an incoming X-Request-Id', async () => {
    const res = await t.agent.get('/health/live').set('X-Request-Id', 'client-id-1').expect(200);
    expect(res.headers['x-request-id']).toBe('client-id-1');
  });

  it('generates a UUIDv7 request id when none is sent', async () => {
    const res = await t.agent.get('/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(UUID_V7);
  });

  it('puts the request id in the problem body too', async () => {
    const res = await t.agent.get('/v1/nope').set('X-Request-Id', 'trace-42').expect(404);
    expect(res.body).toMatchObject({ request_id: 'trace-42' });
  });

  it('rejects a body over 10kb with a 413 problem+json', async () => {
    const res = await t.agent
      .post('/v1/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(11 * 1024) }))
      .expect(413);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('sets security headers and no CORS headers', async () => {
    const res = await t.agent.get('/health/live').set('Origin', 'https://evil.example').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
