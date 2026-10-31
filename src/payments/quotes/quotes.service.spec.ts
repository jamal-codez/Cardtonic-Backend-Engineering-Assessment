import { FakeClock } from '../../common/clock/clock';
import type { AppConfig } from '../../common/config/config';
import type { Db } from '../../common/db/with-transaction';
import type { AppError } from '../../common/errors/app-error';
import type { ConversionService } from '../conversion/conversion.service';
import { QuotesService, type QuoteUse } from './quotes.service';

const START = new Date('2026-01-01T00:00:00.000Z');
const WALLET = '01a18e56-7952-729f-ab7d-cb9426c0fd98';
const OTHER = '01a18e56-7952-729f-ab7d-cb9426c0fd99';
const QUOTE = '01a18e56-7952-729f-ab7d-cb9426c0fd90';

const USE: QuoteUse = {
  quoteId: QUOTE,
  walletId: WALLET,
  from: 'cNGN',
  to: 'USDx',
  sourceMinor: 1_500_000_000n,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTE,
    walletId: WALLET,
    fromCurrency: 'cNGN',
    toCurrency: 'USDx',
    sourceAmount: 1_500_000_000n,
    destAmount: 999_999n,
    rate: '0.000666666666',
    rateSource: 'static',
    rateAsOf: START,
    expiresAt: new Date(START.getTime() + 30_000),
    usedAt: null,
    ...overrides,
  };
}

/** Just enough of the builder: select().from().where().for() and update().set().where(). */
function setup(found: Record<string, unknown> | null) {
  const update = jest.fn();
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ for: () => Promise.resolve(found ? [found] : []) }) }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          update(values);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Db;
  const clock = new FakeClock(START);
  const service = new QuotesService({} as Db, {} as ConversionService, clock, {
    FX_QUOTE_TTL_MS: 30_000,
  } as AppConfig);
  return { service, tx, clock, update };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as AppError).code;
  }
  return undefined;
}

describe('QuotesService.consume', () => {
  it('returns the stored rate and amounts with rate_source quote and marks the quote used', async () => {
    const { service, tx, update } = setup(row());

    const quote = await service.consume(tx, USE);

    expect(quote).toMatchObject({
      rate: '0.000666666666',
      rateSource: 'quote',
      destMinor: 999_999n,
      sourceMinor: 1_500_000_000n,
      quoteId: QUOTE,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown quote as QUOTE_NOT_FOUND', async () => {
    const { service, tx } = setup(null);
    expect(await codeOf(service.consume(tx, USE))).toBe('QUOTE_NOT_FOUND');
  });

  it.each([
    ['another wallet', { walletId: OTHER }],
    ['another source currency', { fromCurrency: 'cGHS' }],
    ['another destination currency', { toCurrency: 'EURx' }],
    ['another amount', { sourceAmount: 1n }],
  ])('reports %s as QUOTE_MISMATCH and does not use the quote', async (_name, overrides) => {
    const { service, tx, update } = setup(row(overrides));

    expect(await codeOf(service.consume(tx, USE))).toBe('QUOTE_MISMATCH');
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a used quote as QUOTE_USED, even when it has also expired', async () => {
    const { service, tx, clock } = setup(row({ usedAt: START }));
    clock.advance(60_000);

    expect(await codeOf(service.consume(tx, USE))).toBe('QUOTE_USED');
  });

  it('reports a mismatch ahead of used and expired', async () => {
    const { service, tx, clock } = setup(row({ walletId: OTHER, usedAt: START }));
    clock.advance(60_000);

    expect(await codeOf(service.consume(tx, USE))).toBe('QUOTE_MISMATCH');
  });

  it('is valid until the expiry instant and expired from it on', async () => {
    const { service, tx, clock } = setup(row());
    clock.advance(29_999);
    await expect(service.consume(tx, USE)).resolves.toBeDefined();

    const again = setup(row());
    again.clock.advance(30_000);
    expect(await codeOf(again.service.consume(again.tx, USE))).toBe('QUOTE_EXPIRED');
    expect(again.update).not.toHaveBeenCalled();
  });
});
