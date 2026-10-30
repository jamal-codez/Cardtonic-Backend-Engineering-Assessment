import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../common/errors/app-error';
import { parseCurrency, type CurrencyCode } from '../common/money/currency';
import { formatUsd2dp } from '../common/money/money';
import { FX_PROVIDER, usdRatesSchema, type FxProvider, type FxSource } from './fx-provider';
import type { FxSnapshot } from './fx-snapshot';
import { FxSnapshotStore } from './fx-snapshot.store';
import { crossRate, rateMatrix, usdValueMinor, type RatePair } from './rates';
import { StaticFxProvider } from './static-fx-provider';

const REFRESH_TIMEOUT_MS = 5_000;
/** Upper bound for a whole refresh, including persisting the snapshot. */
const REFRESH_DEADLINE_MS = 15_000;

export interface RateQuote {
  /** Exactly 12 decimals: the string that is recorded and used for conversion. */
  rate: string;
  source: FxSource;
  asOf: Date;
}

export interface UsdValue {
  /** Two decimals, rounded down. */
  amount: string;
  ratesAsOf: Date;
  source: FxSource;
  indicative: true;
}

export interface RateMatrix {
  pairs: RatePair[];
  source: FxSource;
  asOf: Date;
  fetchedAt: Date;
}

export interface FxStatus {
  loaded: boolean;
  source: FxSource | null;
  asOf: Date | null;
}

/**
 * The only class that knows about providers. It keeps the current snapshot in memory, refreshes
 * it in the background and persists every fetch. Callers see getRate and usdValue (plus the
 * read-only matrix and status used by the rates endpoint and readiness).
 */
@Injectable()
export class RateService implements OnModuleInit {
  private snapshot: FxSnapshot | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly store: FxSnapshotStore,
    @Inject(FX_PROVIDER) private readonly provider: FxProvider,
    private readonly staticProvider: StaticFxProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  /** Loads the latest stored snapshot; with none, fetches static rates and persists them. */
  async initialize(): Promise<void> {
    const latest = await this.store.latest();
    if (latest) {
      this.snapshot = latest;
      return;
    }
    await this.fetchAndStore(this.staticProvider);
  }

  /** Fetches from the configured provider, persists the result and swaps the snapshot. */
  refresh(): Promise<void> {
    this.inFlight ??= this.withDeadline(
      this.fetchAndStore(this.provider, AbortSignal.timeout(REFRESH_TIMEOUT_MS)),
    ).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  getRate(from: CurrencyCode, to: CurrencyCode): RateQuote {
    const snapshot = this.current();
    return {
      rate: crossRate(snapshot.usdRates, from, to),
      source: snapshot.source,
      asOf: snapshot.asOf,
    };
  }

  /** Indicative USD total of the given balances, each converted and floored on its own. */
  usdValue(balances: { currency: string; balance: bigint }[]): UsdValue {
    const snapshot = this.current();
    const total = usdValueMinor(
      snapshot.usdRates,
      balances.map(({ currency, balance }) => ({ currency: parseCurrency(currency), balance })),
    );
    return {
      amount: formatUsd2dp(total),
      ratesAsOf: snapshot.asOf,
      source: snapshot.source,
      indicative: true,
    };
  }

  getRateMatrix(): RateMatrix {
    const snapshot = this.current();
    return {
      pairs: rateMatrix(snapshot.usdRates),
      source: snapshot.source,
      asOf: snapshot.asOf,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  status(): FxStatus {
    return {
      loaded: this.snapshot !== null,
      source: this.snapshot?.source ?? null,
      asOf: this.snapshot?.asOf ?? null,
    };
  }

  private current(): FxSnapshot {
    if (!this.snapshot) {
      throw new AppError('FX_UNAVAILABLE', {
        detail: 'FX rates have not been loaded yet',
        retryAfterSeconds: 1,
      });
    }
    return this.snapshot;
  }

  private async fetchAndStore(provider: FxProvider, signal?: AbortSignal): Promise<void> {
    // The network call (a no-op for the static provider) happens before any database work.
    const fetched = await provider.fetchUsdRates(signal);
    const rates = usdRatesSchema.safeParse(fetched.rates);
    if (!rates.success) {
      throw new AppError('FX_UNAVAILABLE', {
        detail: `The ${provider.name} FX provider returned an invalid rate table`,
        retryAfterSeconds: 1,
      });
    }
    const snapshot = {
      usdRates: rates.data,
      source: provider.name,
      asOf: fetched.providerUpdatedAt,
    };
    const fetchedAt = await this.store.insert(snapshot);
    // Never let a slow, older fetch overwrite a snapshot that was stored after it.
    if (this.snapshot && fetchedAt < this.snapshot.fetchedAt) return;
    this.snapshot = { ...snapshot, fetchedAt };
  }

  /** Bounds the whole refresh (provider call and database insert) so one hang cannot pin it. */
  private async withDeadline(work: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AppError('FX_UNAVAILABLE', { detail: 'FX refresh timed out' })),
        REFRESH_DEADLINE_MS,
      );
    });
    try {
      await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
