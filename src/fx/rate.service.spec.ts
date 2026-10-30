import type { AppError } from '../common/errors/app-error';
import type { FxRates, UsdRates } from './fx-provider';
import type { FxSnapshot } from './fx-snapshot';
import type { FxSnapshotStore } from './fx-snapshot.store';
import { RateService } from './rate.service';
import type { StaticFxProvider } from './static-fx-provider';

const STATIC_RATES: UsdRates = { USD: '1', NGN: '1500', GHS: '15', XAF: '600', EUR: '0.92' };
const AS_OF = new Date('2026-01-01T00:00:00.000Z');
const FETCHED_AT = new Date('2026-01-01T00:00:01.000Z');

function setup(options: { latest?: FxSnapshot | null } = {}) {
  const latest = jest.fn(() => Promise.resolve(options.latest ?? null));
  const insert = jest.fn<Promise<Date>, [unknown]>(() => Promise.resolve(FETCHED_AT));
  const staticFetch = jest.fn((): Promise<FxRates> =>
    Promise.resolve({ rates: STATIC_RATES, providerUpdatedAt: AS_OF }),
  );
  // The configured provider differs from the static one so tests can tell them apart.
  const primaryFetch = jest.fn((): Promise<FxRates> =>
    Promise.resolve({ rates: { ...STATIC_RATES, NGN: '1600' }, providerUpdatedAt: AS_OF }),
  );
  const service = new RateService(
    { latest, insert } as unknown as FxSnapshotStore,
    { name: 'static', fetchUsdRates: primaryFetch },
    { name: 'static', fetchUsdRates: staticFetch } as unknown as StaticFxProvider,
  );
  return { service, insert, staticFetch, primaryFetch };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as AppError).code;
  }
  return undefined;
}

describe('RateService', () => {
  it('fetches and persists the static rates when the store is empty', async () => {
    const { service, insert, staticFetch } = setup();

    await service.initialize();

    expect(staticFetch).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({ usdRates: STATIC_RATES, source: 'static', asOf: AS_OF });
    expect(service.status()).toEqual({ loaded: true, source: 'static', asOf: AS_OF });
  });

  it('uses an existing snapshot and writes nothing', async () => {
    const latest: FxSnapshot = {
      usdRates: { ...STATIC_RATES, NGN: '1700' },
      source: 'live',
      asOf: AS_OF,
      fetchedAt: FETCHED_AT,
    };
    const { service, insert, staticFetch } = setup({ latest });

    await service.initialize();

    expect(insert).not.toHaveBeenCalled();
    expect(staticFetch).not.toHaveBeenCalled();
    expect(service.getRate('cNGN', 'USDx')).toEqual({
      rate: '0.000588235294',
      source: 'live',
      asOf: AS_OF,
    });
  });

  it('refresh() fetches from the configured provider, persists and swaps the snapshot', async () => {
    const { service, insert, primaryFetch } = setup();
    await service.initialize();
    expect(service.getRate('USDx', 'cNGN').rate).toBe('1500.000000000000');

    await service.refresh();

    expect(primaryFetch).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(service.getRate('USDx', 'cNGN').rate).toBe('1600.000000000000');
  });

  it('coalesces overlapping refreshes into one fetch', async () => {
    const { service, primaryFetch } = setup();
    await service.initialize();

    await Promise.all([service.refresh(), service.refresh(), service.refresh()]);

    expect(primaryFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    const { service, primaryFetch } = setup();
    await service.initialize();
    primaryFetch.mockRejectedValueOnce(new Error('provider down'));

    await expect(service.refresh()).rejects.toThrow('provider down');

    expect(service.getRate('USDx', 'cNGN').rate).toBe('1500.000000000000');
    // The failed refresh is no longer in flight, so a later one can run.
    await expect(service.refresh()).resolves.toBeUndefined();
  });

  it('rejects an invalid rate table from a provider and keeps the old snapshot', async () => {
    const { service, primaryFetch } = setup();
    await service.initialize();
    primaryFetch.mockResolvedValueOnce({
      rates: { ...STATIC_RATES, NGN: '0' },
      providerUpdatedAt: AS_OF,
    });

    await expect(service.refresh()).rejects.toMatchObject({ code: 'FX_UNAVAILABLE' });
    expect(service.getRate('USDx', 'cNGN').rate).toBe('1500.000000000000');
  });

  it('does not let an older fetch overwrite a newer snapshot', async () => {
    const { service, insert, primaryFetch } = setup();
    await service.initialize(); // stored at FETCHED_AT
    insert.mockResolvedValueOnce(new Date(FETCHED_AT.getTime() - 5_000));

    await service.refresh();

    expect(primaryFetch).toHaveBeenCalledTimes(1);
    expect(service.getRate('USDx', 'cNGN').rate).toBe('1500.000000000000');
  });

  it('gives up on a refresh whose database insert hangs, and allows the next one', async () => {
    jest.useFakeTimers();
    try {
      const { service, insert } = setup();
      await service.initialize();
      insert.mockImplementationOnce(() => new Promise<Date>(() => undefined));

      const hung = service.refresh();
      const outcome = expect(hung).rejects.toMatchObject({ code: 'FX_UNAVAILABLE' });
      await jest.advanceTimersByTimeAsync(15_000);
      await outcome;

      await expect(service.refresh()).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers FX_UNAVAILABLE before any snapshot is loaded', () => {
    const { service } = setup();
    expect(service.status()).toEqual({ loaded: false, source: null, asOf: null });
    expect(errorCode(() => service.getRate('cNGN', 'cGHS'))).toBe('FX_UNAVAILABLE');
    expect(errorCode(() => service.usdValue([]))).toBe('FX_UNAVAILABLE');
  });

  it('usdValue rounds down to 2 decimals and is flagged indicative', async () => {
    const { service } = setup();
    await service.initialize();

    const value = service.usdValue([
      { currency: 'USDx', balance: 1_999_999n },
      { currency: 'cNGN', balance: 1n },
    ]);

    expect(value).toEqual({
      amount: '1.99',
      ratesAsOf: AS_OF,
      source: 'static',
      indicative: true,
    });
  });

  it('exposes the 20-pair matrix with the snapshot timestamps', async () => {
    const { service } = setup();
    await service.initialize();

    const matrix = service.getRateMatrix();

    expect(matrix.pairs).toHaveLength(20);
    expect(matrix.asOf).toBe(AS_OF);
    expect(matrix.fetchedAt).toBe(FETCHED_AT);
  });
});
