import { RateDecimal } from '../common/money/decimal';
import { FIATS, usdRatesSchema, type UsdRates } from './fx-provider';

export type SnapshotVerdict = { ok: true; rates: UsdRates } | { ok: false; reason: string };

/**
 * Decides whether a freshly produced rate table may be stored and used. Pure.
 *
 * It checks the data itself, not just that a fetch "succeeded": every supported fiat is present,
 * every rate is a finite positive number (a plain decimal string is accepted too), the table
 * passes the shared bounds (USD exactly 1, each rate within sane limits), and no rate moved more
 * than `maxMovePct` against `previous`. Without a previous snapshot the move check is skipped.
 */
export function validateSnapshot(
  raw: Record<string, unknown>,
  previous: UsdRates | null,
  maxMovePct: number,
): SnapshotVerdict {
  const converted: Record<string, string> = {};
  for (const fiat of FIATS) {
    if (!(fiat in raw) || raw[fiat] === undefined || raw[fiat] === null) {
      return { ok: false, reason: `${fiat} is missing` };
    }
    const value = raw[fiat];
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, reason: `${fiat} is not a finite positive number` };
      }
      converted[fiat] = new RateDecimal(value).toString(); // exact, never an exponent
    } else if (typeof value === 'string') {
      converted[fiat] = value;
    } else {
      return { ok: false, reason: `${fiat} is not a number` };
    }
  }

  const parsed = usdRatesSchema.safeParse(converted);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? 'table';
    return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid rate table'}` };
  }

  if (previous) {
    const limit = new RateDecimal(String(maxMovePct));
    for (const fiat of FIATS) {
      const before = new RateDecimal(previous[fiat]);
      const movePct = new RateDecimal(parsed.data[fiat]).minus(before).abs().div(before).times(100);
      if (movePct.gt(limit)) {
        return {
          ok: false,
          reason: `${fiat} moved ${movePct.toDecimalPlaces(1).toString()}% (limit ${String(maxMovePct)}%)`,
        };
      }
    }
  }
  return { ok: true, rates: parsed.data };
}
