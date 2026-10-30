import type { RateMatrix } from './rate.service';

export interface RatesResource {
  base: 'USD';
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
