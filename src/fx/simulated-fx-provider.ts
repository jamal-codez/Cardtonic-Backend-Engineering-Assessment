import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock/clock';
import { APP_CONFIG, type AppConfig } from '../common/config/config';
import { RateDecimal } from '../common/money/decimal';
import { RANDOM, type Random } from '../common/runtime/runtime';
import { FIATS, type FxProvider, type FxRates, type UsdRates } from './fx-provider';
import { StaticFxProvider } from './static-fx-provider';

/** Roughly one refresh in seven is a medium step; the rest are small. */
const MEDIUM_STEP_PROBABILITY = 0.15;
const RATE_DECIMALS = 6;

/**
 * A stand-in for a live market: a bounded random walk around the static rates.
 *
 * Each call to `fetchUsdRates` moves every non-USD rate by a random step, small most of the time
 * and occasionally medium, then keeps it inside a band around the anchor (the rates in
 * config/static-rates.json) so a feed that runs for weeks cannot drift to absurd values. USD stays
 * exactly 1. The arithmetic on rates uses the local Decimal clone; only the noise itself is a
 * float, and it is injected (`RANDOM`) so tests can seed it.
 *
 * It plays the role of the live feed, so its snapshots and conversions are recorded with source
 * `live` (the allowed values are fixed); it is not real market data.
 */
@Injectable()
export class SimulatedFxProvider implements FxProvider {
  readonly name = 'live' as const;
  private readonly anchor: UsdRates;

  constructor(
    staticProvider: StaticFxProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RANDOM) private readonly random: Random,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.anchor = staticProvider.anchorRates();
  }

  /**
   * One step from `previous` (the last accepted table; the anchor when there is none). Holds no
   * state, so a step that is rejected or fails to persist is simply never taken. A `previous` that
   * lies outside the band is pulled back inside it by the clamp.
   */
  fetchUsdRates(_signal?: AbortSignal, previous?: UsdRates): Promise<FxRates> {
    try {
      const from = previous ?? this.anchor;
      const next: Record<string, string> = {};
      for (const fiat of FIATS) {
        next[fiat] = fiat === 'USD' ? '1' : this.step(fiat, from[fiat]);
      }
      return Promise.resolve({ rates: next, providerUpdatedAt: this.clock.now() });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private step(fiat: (typeof FIATS)[number], from: string): string {
    const medium = this.random() < MEDIUM_STEP_PROBABILITY;
    const maxStepPct = medium
      ? this.config.FX_SIM_MEDIUM_STEP_PCT
      : this.config.FX_SIM_SMALL_STEP_PCT;
    // A uniform step in [-maxStepPct, +maxStepPct] percent.
    const stepPct = new RateDecimal(this.random()).times(2).minus(1).times(String(maxStepPct));
    const moved = new RateDecimal(from).times(new RateDecimal(1).plus(stepPct.div(100)));

    const anchor = new RateDecimal(this.anchor[fiat]);
    const band = new RateDecimal(String(this.config.FX_SIM_BAND_PCT)).div(100);
    const low = anchor.times(new RateDecimal(1).minus(band));
    const high = anchor.times(new RateDecimal(1).plus(band));
    const bounded = RateDecimal.min(RateDecimal.max(moved, low), high);

    if (!bounded.isFinite()) {
      // A broken random source (NaN) must fail this step, not produce a table.
      throw new Error(`The random source produced an unusable step for ${fiat}`);
    }
    return bounded.toDecimalPlaces(RATE_DECIMALS).toString();
  }
}
