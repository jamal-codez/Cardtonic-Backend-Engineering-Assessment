import type { Response } from 'express';
import type { Pool } from 'pg';
import type { RateService } from '../fx/rate.service';
import { HealthController } from './health.controller';

function setup(options: { loaded: boolean; databaseUp?: boolean; lastError?: string }) {
  const pool = {
    query: jest.fn(() =>
      options.databaseUp === false ? Promise.reject(new Error('down')) : Promise.resolve({}),
    ),
  };
  const asOf = new Date('2026-01-01T00:00:00.000Z');
  const rates = {
    status: () =>
      options.loaded
        ? {
            loaded: true,
            provider: 'simulated',
            source: 'live',
            asOf,
            lastError: options.lastError ?? null,
          }
        : { loaded: false, provider: 'simulated', source: null, asOf: null, lastError: null },
  };
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
  const controller = new HealthController(pool as unknown as Pool, rates as unknown as RateService);
  return { controller, res, headers };
}

describe('HealthController.ready', () => {
  it('is ok when the database is up and the rates are loaded', async () => {
    const { controller, res } = setup({ loaded: true });
    const body = await controller.ready(res as unknown as Response);
    expect(body).toEqual({
      status: 'ok',
      checks: {
        database: 'up',
        fx: { provider: 'simulated', source: 'live', as_of: '2026-01-01T00:00:00.000Z' },
      },
    });
    expect(res.statusCode).toBe(0);
  });

  it('answers 503 with Retry-After while the rates are not loaded', async () => {
    const { controller, res, headers } = setup({ loaded: false });
    const body = await controller.ready(res as unknown as Response);
    expect(body.status).toBe('unavailable');
    expect(body.checks.fx).toEqual({ provider: 'simulated', source: null, as_of: null });
    expect(res.statusCode).toBe(503);
    expect(headers['Retry-After']).toBe('1');
  });

  it('stays ready, and reports the reason, when the latest refresh failed', async () => {
    const { controller, res } = setup({
      loaded: true,
      lastError: 'Rejected a rate table: NGN is missing',
    });
    const body = await controller.ready(res as unknown as Response);
    expect(body.status).toBe('ok');
    expect(body.checks.fx.last_error).toBe('Rejected a rate table: NGN is missing');
    expect(res.statusCode).toBe(0);
  });

  it('answers 503 when the database is down', async () => {
    const { controller, res } = setup({ loaded: true, databaseUp: false });
    const body = await controller.ready(res as unknown as Response);
    expect(body.checks.database).toBe('down');
    expect(res.statusCode).toBe(503);
  });
});
