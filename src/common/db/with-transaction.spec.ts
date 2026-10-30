import type { Pool } from 'pg';
import { AppError } from '../errors/app-error';
import { withTransaction } from './with-transaction';

function fakePool() {
  const queries: string[] = [];
  const client = {
    query: jest.fn((sql: string) => {
      queries.push(sql);
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(() => Promise.resolve(client)) } as unknown as Pool;
  return { pool, client, queries };
}

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('withTransaction', () => {
  it('commits and sets local timeouts on success', async () => {
    const { pool, queries } = fakePool();
    const result = await withTransaction(pool, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(queries).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '2s'`,
      `SET LOCAL statement_timeout = '5s'`,
      'COMMIT',
    ]);
  });

  it('retries on 40P01 up to 3 times, then throws RETRY_LATER', async () => {
    const { pool, client } = fakePool();
    const sleep = jest.fn(() => Promise.resolve());
    const fn = jest.fn(() => Promise.reject(pgError('40P01')));

    const error = await withTransaction(pool, fn, { sleep, random: () => 0 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RETRY_LATER');
    expect((error as AppError).retryAfterSeconds).toBe(1);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledTimes(4);
  });

  it('keeps jitter between 50ms and 400ms', async () => {
    const { pool } = fakePool();
    const sleep = jest.fn(() => Promise.resolve());
    const fn = jest.fn(() => Promise.reject(pgError('40001')));
    await withTransaction(pool, fn, { sleep, random: () => 0.999999 }).catch(() => undefined);
    await withTransaction(pool, fn, { sleep, random: () => 0 }).catch(() => undefined);
    const delays = sleep.mock.calls.map((call) => (call as unknown as number[])[0] ?? -1);
    expect(Math.min(...delays)).toBe(50);
    expect(Math.max(...delays)).toBeLessThanOrEqual(400);
  });

  it('recovers when a retry succeeds', async () => {
    const { pool } = fakePool();
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(pgError('55P03'))
      .mockResolvedValueOnce('done');
    await expect(withTransaction(pool, fn, { sleep: () => Promise.resolve() })).resolves.toBe(
      'done',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 23505', async () => {
    const { pool, queries } = fakePool();
    const sleep = jest.fn(() => Promise.resolve());
    const fn = jest.fn(() => Promise.reject(pgError('23505')));

    await expect(withTransaction(pool, fn, { sleep })).rejects.toMatchObject({ code: '23505' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(queries).toContain('ROLLBACK');
  });
});
