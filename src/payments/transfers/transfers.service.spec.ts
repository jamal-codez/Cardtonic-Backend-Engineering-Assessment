import type { AppConfig } from '../../common/config/config';
import { AppError } from '../../common/errors/app-error';
import type { IdempotencyService, WorkResult } from '../../idempotency/idempotency.service';
import type { LedgerService } from '../../ledger/ledger.service';
import type { ConversionService } from '../conversion/conversion.service';
import { TransfersService } from './transfers.service';

const SENDER = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
const RECEIVER = '01a18e56-7952-729f-ab7d-cb9426c0fd99';
const CONFIG = { MAX_TX_AMOUNT: 1_000_000_000n } as AppConfig;

function setup(options: { quoteError?: AppError } = {}) {
  const calls: string[] = [];
  const quoteForExecution = jest.fn(() => {
    calls.push('quote');
    if (options.quoteError) throw options.quoteError;
    return {
      from: 'cNGN',
      to: 'cGHS',
      sourceMinor: 1n,
      destMinor: 1n,
      rate: '0.010000000000',
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
  const service = new TransfersService(
    { execute } as unknown as IdempotencyService,
    {} as LedgerService,
    { quoteForExecution } as unknown as ConversionService,
    CONFIG,
  );
  return { service, calls, quoteForExecution, execute, work: () => capturedWork };
}

const dto = (overrides: Record<string, string | undefined> = {}) => ({
  to_wallet_id: RECEIVER,
  source_currency: 'cNGN',
  destination_currency: undefined as string | undefined,
  amount: '10',
  ...overrides,
});

/** Just enough of the Drizzle builder for the wallet lookup: select().from().where(). */
function fakeTx(foundIds: string[]) {
  return {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(foundIds.map((id) => ({ id }))) }),
    }),
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

describe('TransfersService', () => {
  describe('same currency', () => {
    it('never calls the conversion (rate) service', async () => {
      const { service, quoteForExecution, execute } = setup();

      await service.transfer(SENDER, dto(), 'k1', 'req');
      await service.transfer(SENDER, dto({ destination_currency: 'cngn' }), 'k2', 'req');

      expect(execute).toHaveBeenCalledTimes(2);
      expect(quoteForExecution).not.toHaveBeenCalled();
    });

    it('hashes a missing destination_currency like an explicit identical one', async () => {
      const { service, execute } = setup();
      await service.transfer(SENDER, dto(), 'k1', 'req');
      await service.transfer(
        SENDER,
        dto({ destination_currency: 'CNGN', amount: '10.0' }),
        'k1',
        'req',
      );
      expect(execute.mock.calls[0]?.[2]).toBe(execute.mock.calls[1]?.[2]);
    });
  });

  describe('cross currency', () => {
    it('resolves the rate before it opens the idempotency/transaction boundary', async () => {
      const { service, calls } = setup();
      await service.transfer(SENDER, dto({ destination_currency: 'cGHS' }), 'k1', 'req');
      expect(calls).toEqual(['quote', 'execute']);
    });

    it('hashes a different destination currency differently', async () => {
      const { service, execute } = setup();
      await service.transfer(SENDER, dto(), 'k1', 'req');
      await service.transfer(SENDER, dto({ destination_currency: 'cGHS' }), 'k1', 'req');
      expect(execute.mock.calls[0]?.[2]).not.toBe(execute.mock.calls[1]?.[2]);
    });
  });

  describe('validation happens before any quote or execute', () => {
    it.each([
      ['a self-transfer', dto({ to_wallet_id: SENDER }), 'SELF_TRANSFER'],
      [
        'a self-transfer written in upper case',
        dto({ to_wallet_id: SENDER.toUpperCase() }),
        'SELF_TRANSFER',
      ],
      [
        'a self-transfer into another currency',
        dto({ to_wallet_id: SENDER, destination_currency: 'cGHS' }),
        'SELF_TRANSFER',
      ],
      [
        'a self-transfer with an invalid currency (self check wins)',
        dto({ to_wallet_id: SENDER, source_currency: 'XYZ' }),
        'SELF_TRANSFER',
      ],
      ['an unsupported source currency', dto({ source_currency: 'XYZ' }), 'UNSUPPORTED_CURRENCY'],
      [
        'an unsupported destination currency',
        dto({ destination_currency: 'XYZ' }),
        'UNSUPPORTED_CURRENCY',
      ],
      ['a zero amount', dto({ amount: '0' }), 'VALIDATION_ERROR'],
      ['an amount over the limit', dto({ amount: '1000000000.000001' }), 'AMOUNT_LIMIT_EXCEEDED'],
    ])('rejects %s', (_label, body, code) => {
      const { service, calls } = setup();
      expect(errorCode(() => service.transfer(SENDER, body, 'k1', 'req'))).toBe(code);
      expect(calls).toEqual([]);
    });
  });

  describe('checks inside the work', () => {
    const crossDto = () => dto({ destination_currency: 'cGHS' });

    it('answers WALLET_NOT_FOUND for a missing sender, before any captured quote failure', async () => {
      const { service, work } = setup({ quoteError: new AppError('AMOUNT_TOO_SMALL') });
      await service.transfer(SENDER, crossDto(), 'k1', 'req');
      await expect(work()?.(fakeTx([RECEIVER]) as never)).rejects.toMatchObject({
        code: 'WALLET_NOT_FOUND',
      });
    });

    it('answers RECIPIENT_NOT_FOUND for a missing recipient, before any captured quote failure', async () => {
      const { service, work } = setup({ quoteError: new AppError('AMOUNT_TOO_SMALL') });
      await service.transfer(SENDER, crossDto(), 'k1', 'req');
      await expect(work()?.(fakeTx([SENDER]) as never)).rejects.toMatchObject({
        code: 'RECIPIENT_NOT_FOUND',
      });
    });

    it('rethrows a captured quote failure once both wallets exist', async () => {
      const error = new AppError('AMOUNT_TOO_SMALL');
      const { service, work } = setup({ quoteError: error });
      await service.transfer(SENDER, crossDto(), 'k1', 'req');
      await expect(work()?.(fakeTx([SENDER, RECEIVER]) as never)).rejects.toBe(error);
    });
  });
});
