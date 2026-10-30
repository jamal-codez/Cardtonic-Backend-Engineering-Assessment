import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { AppError } from '../common/errors/app-error';
import { parseCurrency, type CurrencyCode } from '../common/money/currency';
import { formatUsd2dp } from '../common/money/money';
import { FX_PROVIDER, type FxProvider, type FxSource } from './fx-provider';
import type { FxSnapshot } from './fx-snapshot';
import { FxSnapshotStore } from './fx-snapshot.store';
import { crossRate, rateMatrix, usdValueMinor, type RatePair } from './rates';
import { validateSnapshot } from './snapshot-validation';
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
  /** Which provider feeds the rates (`simulated` plays the role of the live feed). */
  provider: AppConfig['FX_PROVIDER'];
  source: FxSource;
  asOf: Date;
  fetchedAt: Date;
}

export interface FxStatus {
  loaded: boolean;
  provider: AppConfig['FX_PROVIDER'];
  source: FxSource | null;
  asOf: Date | null;
  /** Why the most recent refresh failed or was rejected; null after a good one. */
  lastError: string | null;
}

/**
 * The only class that knows about providers. It keeps the current snapshot in memory, refreshes
 * it in the background and persists every accepted snapshot. Callers see getRate and usdValue
 * (plus the read-only matrix and status used by the rates endpoint and readiness).
 *
 * Every table a provider produces is validated before it is stored or used (see
 * snapshot-validation.ts). A rejected table is never persisted and never replaces the snapshot.
 */
@Injectable()
export class RateService implements OnModuleInit {
  private readonly logger = new Logger(RateService.name);
  private snapshot: FxSnapshot | null = null;
  private inFlight: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: FxSnapshotStore,
    @Inject(FX_PROVIDER) private readonly provider: FxProvider,
    private readonly staticProvider: StaticFxProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  /**
   * Loads the latest stored snapshot of this provider's source, so a restart continues the feed
   * where it stopped. With none stored, the first snapshot is the anchor (the static rates), recorded under
   * this provider's source. Nothing here waits for a refresh: boot never depends on the feed.
   */
  async initialize(): Promise<void> {
    const latest = await this.store.latest(this.provider.name);
    if (latest) {
      this.snapshot = latest;
      return;
    }
    const anchor = await this.staticProvider.fetchUsdRates();
    const verdict = validateSnapshot(anchor.rates, null, this.config.FX_MAX_MOVE_PCT);
    if (!verdict.ok) {
      throw new AppError('FX_UNAVAILABLE', {
        detail: `The static rates are unusable: ${verdict.reason}`,
        retryAfterSeconds: 1,
      });
    }
    const snapshot = {
      usdRates: verdict.rates,
      source: this.provider.name,
      asOf: anchor.providerUpdatedAt,
    };
    const fetchedAt = await this.store.insert(snapshot);
    this.snapshot = { ...snapshot, fetchedAt };
  }

  /** Asks the provider for new rates, validates them, persists them and swaps the snapshot. */
  refresh(): Promise<void> {
    this.inFlight ??= this.withDeadline(
      this.fetchAndStore(this.provider, AbortSignal.timeout(REFRESH_TIMEOUT_MS)),
    ).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Resolves once any refresh in progress has finished (failed or not). For tests and shutdown. */
  async settled(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
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
      provider: this.config.FX_PROVIDER,
      source: snapshot.source,
      asOf: snapshot.asOf,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  status(): FxStatus {
    return {
      loaded: this.snapshot !== null,
      provider: this.config.FX_PROVIDER,
      source: this.snapshot?.source ?? null,
      asOf: this.snapshot?.asOf ?? null,
      lastError: this.lastError,
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
    // Step from the newest stored table of this source, not from memory: replicas then share one
    // series instead of each walking its own, and a step that was never stored is never built on.
    const base = (await this.store.latest(provider.name))?.usdRates ?? this.snapshot?.usdRates;
    let fetched;
    try {
      fetched = await provider.fetchUsdRates(signal, base);
    } catch (error) {
      this.lastError = `The ${provider.name} FX provider failed: ${describe(error)}`;
      throw error;
    }

    const verdict = validateSnapshot(fetched.rates, base ?? null, this.config.FX_MAX_MOVE_PCT);
    if (!verdict.ok) {
      // Never persisted, never used: the previous snapshot stays in force.
      this.lastError = `Rejected a rate table from the ${provider.name} FX provider: ${verdict.reason}`;
      this.logger.warn({ reason: verdict.reason, provider: provider.name }, 'Rejected FX snapshot');
      throw new AppError('FX_UNAVAILABLE', {
        detail: this.lastError,
        retryAfterSeconds: 1,
      });
    }

    const snapshot = {
      usdRates: verdict.rates,
      source: provider.name,
      asOf: fetched.providerUpdatedAt,
    };
    const fetchedAt = await this.store.insert(snapshot);
    // Never let a slow, older fetch overwrite a snapshot that was stored after it.
    if (this.snapshot && fetchedAt < this.snapshot.fetchedAt) return;
    this.snapshot = { ...snapshot, fetchedAt };
    this.lastError = null;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
