import type { FxSource, UsdRates } from './fx-provider';

export interface FxSnapshot {
  usdRates: UsdRates;
  source: FxSource;
  /** provider_updated_at: when the provider says the rates are from. */
  asOf: Date;
  /** fetched_at: when we stored them. */
  fetchedAt: Date;
}
