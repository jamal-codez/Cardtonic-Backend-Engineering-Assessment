import type { RateMatrix } from './rate.service';

export interface RatesResource {
  base: 'USD';
  /** `simulated` means the rates come from a local random-walk feed, not a real market. */
  provider: string;
  source: string;
  as_of: string;
  refreshed_at: string;
  rates: {
    from: string;
    to: string;
    rate: string;
    source: string;
    refreshed_at: string;
  }[];
}

export function toRatesResource(matrix: RateMatrix): RatesResource {
  const refreshedAt = matrix.fetchedAt.toISOString();
  return {
    base: 'USD',
    provider: matrix.provider,
    source: matrix.source,
    as_of: matrix.asOf.toISOString(),
    refreshed_at: refreshedAt,
    rates: matrix.pairs.map(({ from, to, rate }) => ({
      from,
      to,
      rate,
      source: matrix.source,
      refreshed_at: refreshedAt,
    })),
  };
}
