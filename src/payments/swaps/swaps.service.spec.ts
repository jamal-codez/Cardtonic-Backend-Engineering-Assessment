import { AppError } from '../../common/errors/app-error';
import type { AppConfig } from '../../common/config/config';
import type { IdempotencyService, WorkResult } from '../../idempotency/idempotency.service';
import type { LedgerService } from '../../ledger/ledger.service';
import type { ConversionService } from '../conversion/conversion.service';
import { SwapsService } from './swaps.service';

const WALLET = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
const CONFIG = { MAX_TX_AMOUNT: 1_000_000_000n } as AppConfig;

function setup(options: { quoteError?: AppError } = {}) {
  const calls: string[] = [];
  const quoteForExecution = jest.fn(() => {
    calls.push('quote');
    if (options.quoteError) throw options.quoteError;
    return {
      from: 'cNGN',
      to: 'USDx',
      sourceMinor: 1n,
      destMinor: 1n,
      rate: '1.000000000000',
      rateSource: 'static',
      rateAsOf: new Date('2026-01-01T00:00:00.000Z'),
    };
  });
  let capturedWork: ((tx: never) => Promise<WorkResult>) | undefined;
  const execute = jest.fn(
    (_scope: string, _key: string, _hash: string, work: typeof capturedWork) => {
      calls.push('execute');
      capturedWork = work;
      return Promise.resolve({ statusCode: 201, body: {}, replayed: false });
    },
  );
  const service = new SwapsService(
    { execute } as unknown as IdempotencyService,
    {} as LedgerService,
    { quoteForExecution } as unknown as ConversionService,
    CONFIG,
  );
  return { service, calls, quoteForExecution, execute, work: () => capturedWork };
}

const dto = (overrides: Record<string, string> = {}) => ({
  from_currency: 'cNGN',
  to_currency: 'USDx',
  amount: '10',
  ...overrides,
});

/** Just enough of the Drizzle query builder for the wallet lookup: select().from().where(). */
function fakeTx(walletRows: { id: string }[]) {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(walletRows) }) }),
  };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

describe('SwapsService', () => {
  it('resolves the rate before it opens the idempotency/transaction boundary', async () => {
    const { service, calls } = setup();
    await service.swap(WALLET, dto(), 'k1', 'req');
    expect(calls).toEqual(['quote', 'execute']);
  });

  it('hashes "10" and "10.0" and canonical currency spelling the same', async () => {
    const { service, execute } = setup();
    await service.swap(WALLET, dto({ amount: '10' }), 'k1', 'req');
    await service.swap(WALLET, dto({ amount: '10.0', from_currency: 'CNGN' }), 'k1', 'req');
    expect(execute.mock.calls[0]?.[2]).toBe(execute.mock.calls[1]?.[2]);
  });

  it('rethrows a quote failure inside the work, not before execute', async () => {
    const error = new AppError('AMOUNT_TOO_SMALL');
    const { service, execute, work } = setup({ quoteError: error });

    await service.swap(WALLET, dto(), 'k1', 'req');

    expect(execute).toHaveBeenCalledTimes(1);
    const run = work();
    expect(run).toBeDefined();
    await expect(run?.(fakeTx([{ id: WALLET }]) as never)).rejects.toBe(error);
  });

  it('answers WALLET_NOT_FOUND before it surfaces a captured quote failure', async () => {
    const { service, work } = setup({ quoteError: new AppError('AMOUNT_TOO_SMALL') });

    await service.swap(WALLET, dto(), 'k1', 'req');

    await expect(work()?.(fakeTx([]) as never)).rejects.toMatchObject({
      code: 'WALLET_NOT_FOUND',
    });
  });

  it('rejects the same currency before any quote or execute', () => {
    const { service, calls } = setup();
    expect(errorCode(() => service.swap(WALLET, dto({ to_currency: 'cngn' }), 'k1', 'req'))).toBe(
      'SAME_CURRENCY_SWAP',
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ['an unsupported currency', dto({ to_currency: 'XYZ' }), 'UNSUPPORTED_CURRENCY'],
    ['a zero amount', dto({ amount: '0' }), 'VALIDATION_ERROR'],
    ['an amount over the limit', dto({ amount: '1000000000.000001' }), 'AMOUNT_LIMIT_EXCEEDED'],
  ])('rejects %s before any quote or execute', (_label, body, code) => {
    const { service, calls } = setup();
    expect(errorCode(() => service.swap(WALLET, body, 'k1', 'req'))).toBe(code);
    expect(calls).toEqual([]);
  });
});
