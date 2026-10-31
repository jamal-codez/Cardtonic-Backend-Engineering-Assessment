import fc from 'fast-check';
import { FakeClock } from '../common/clock/clock';
import { loadConfig, type AppConfig } from '../common/config/config';
import { RateDecimal } from '../common/money/decimal';
import { convert } from '../common/money/money';
import { seededRandom } from '../../test/helpers/seeded-random';
import { FIATS, usdRatesSchema, type Fiat, type UsdRates } from './fx-provider';
import { rateMatrix } from './rates';
import { SimulatedFxProvider } from './simulated-fx-provider';
import { StaticFxProvider } from './static-fx-provider';

const START = new Date('2026-01-01T00:00:00.000Z');
const CONFIG: AppConfig = loadConfig({ DATABASE_URL: 'postgres://unused' });
const NON_USD = FIATS.filter((fiat) => fiat !== 'USD');

function build(seed: number, config: AppConfig = CONFIG) {
  const clock = new FakeClock(START);
  const staticProvider = new StaticFxProvider(clock);
  const provider = new SimulatedFxProvider(staticProvider, config, seededRandom(seed), clock);
  return { provider, clock, anchor: staticProvider.anchorRates() };
}

async function walk(provider: SimulatedFxProvider, steps: number): Promise<UsdRates[]> {
  const tables: UsdRates[] = [];
  let previous: UsdRates | undefined;
  for (let i = 0; i < steps; i += 1) {
    previous = (await provider.fetchUsdRates(previous)).rates as UsdRates;
    tables.push(previous);
  }
  return tables;
}

/** Relative change of one rate between two tables, as a fraction (0.01 is 1%). */
const relative = (after: string, before: string): number =>
  new RateDecimal(after).div(before).minus(1).abs().toNumber();
const change = (before: UsdRates, after: UsdRates, fiat: Fiat): number =>
  relative(after[fiat], before[fiat]);

describe('SimulatedFxProvider', () => {
  it('is the simulated source and stamps each step with the injected clock', async () => {
    const { provider, clock } = build(1);
    expect(provider.name).toBe('simulated');
    clock.advance(54_000);
    const step = await provider.fetchUsdRates();
    expect(step.providerUpdatedAt).toEqual(new Date(START.getTime() + 54_000));
  });

  it('keeps USD at exactly 1 and returns every supported fiat on every step', async () => {
    const { provider } = build(2);
    for (const table of await walk(provider, 500)) {
      expect(Object.keys(table).sort()).toEqual([...FIATS].sort());
      expect(table.USD).toBe('1');
    }
  });

  it('actually moves the rates', async () => {
    const { provider, anchor } = build(3);
    const tables = await walk(provider, 50);
    const last = tables[tables.length - 1] as UsdRates;
    for (const fiat of NON_USD) expect(last[fiat]).not.toBe(anchor[fiat]);
    expect(new Set(tables.map((t) => t.NGN)).size).toBeGreaterThan(30);
  });

  it('never moves a rate by more than a medium step', async () => {
    const { provider, anchor } = build(4);
    let previous: UsdRates = anchor;
    const mediumFraction = CONFIG.FX_SIM_MEDIUM_STEP_PCT / 100;
    for (const table of await walk(provider, 2_000)) {
      for (const fiat of NON_USD) {
        // A little slack for rounding the result down to 6 decimals.
        expect(change(previous, table, fiat)).toBeLessThanOrEqual(mediumFraction + 2e-6);
      }
      previous = table;
    }
  });

  it('mostly takes small steps, with the occasional medium one', async () => {
    const { provider, anchor } = build(5);
    let previous: UsdRates = anchor;
    const smallFraction = CONFIG.FX_SIM_SMALL_STEP_PCT / 100;
    let total = 0;
    let medium = 0;
    let largest = 0;
    for (const table of await walk(provider, 5_000)) {
      for (const fiat of NON_USD) {
        const moved = change(previous, table, fiat);
        total += 1;
        if (moved > smallFraction + 2e-6) medium += 1;
        largest = Math.max(largest, moved);
      }
      previous = table;
    }
    expect(medium / total).toBeGreaterThan(0.05);
    expect(medium / total).toBeLessThan(0.2);
    expect(largest).toBeGreaterThan(0.01); // some steps really are medium
  });

  it('stays inside the band around the anchor, however long it runs', async () => {
    const { provider, anchor } = build(6);
    const band = CONFIG.FX_SIM_BAND_PCT / 100;
    for (const table of await walk(provider, 10_000)) {
      for (const fiat of NON_USD) {
        expect(relative(table[fiat], anchor[fiat])).toBeLessThanOrEqual(band + 1e-6);
      }
    }
  });

  it('presses against the band instead of leaving it when pushed hard', async () => {
    const tight = loadConfig({
      DATABASE_URL: 'postgres://unused',
      FX_SIM_BAND_PCT: '2',
      FX_SIM_SMALL_STEP_PCT: '1',
      FX_SIM_MEDIUM_STEP_PCT: '2',
    });
    const { provider, anchor } = build(7, tight);
    let reachedEdge = false;
    for (const table of await walk(provider, 3_000)) {
      const drift = relative(table.NGN, anchor.NGN);
      expect(drift).toBeLessThanOrEqual(0.02 + 1e-6);
      if (drift > 0.0199) reachedEdge = true;
    }
    expect(reachedEdge).toBe(true);
  });

  it('is deterministic for a seed and different for another', async () => {
    const a = await walk(build(11).provider, 100);
    const b = await walk(build(11).provider, 100);
    const c = await walk(build(12).provider, 100);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('steps from the table it is given instead of the anchor', async () => {
    const { provider } = build(13);
    const given: UsdRates = { USD: '1', NGN: '1200', GHS: '13', XAF: '550', EUR: '0.85' };

    const next = (await provider.fetchUsdRates(given)).rates as UsdRates;

    for (const fiat of NON_USD) {
      expect(change(given, next, fiat)).toBeLessThanOrEqual(
        CONFIG.FX_SIM_MEDIUM_STEP_PCT / 100 + 2e-6,
      );
    }
  });

  it('holds no state: repeated calls from the same table never compound', async () => {
    const { provider, anchor } = build(14);
    for (let i = 0; i < 200; i += 1) {
      const next = (await provider.fetchUsdRates(anchor)).rates as UsdRates;
      for (const fiat of NON_USD) {
        expect(change(anchor, next, fiat)).toBeLessThanOrEqual(
          CONFIG.FX_SIM_MEDIUM_STEP_PCT / 100 + 2e-6,
        );
      }
    }
  });

  it('pulls a table that lies outside the band back inside it', async () => {
    const { provider, anchor } = build(15);
    const wild: UsdRates = { ...anchor, NGN: '99999', EUR: '0.0011' };

    const next = (await provider.fetchUsdRates(wild)).rates as UsdRates;

    const band = CONFIG.FX_SIM_BAND_PCT / 100;
    expect(relative(next.NGN, anchor.NGN)).toBeLessThanOrEqual(band + 1e-6);
    expect(relative(next.EUR, anchor.EUR)).toBeLessThanOrEqual(band + 1e-6);
  });

  it('fails the step instead of producing a table when the random source is broken', async () => {
    const clock = new FakeClock(START);
    const staticProvider = new StaticFxProvider(clock);
    const broken = new SimulatedFxProvider(staticProvider, CONFIG, () => Number.NaN, clock);

    await expect(broken.fetchUsdRates()).rejects.toThrow(/unusable step/);
  });

  it('only ever produces tables that pass the shared rate checks, with every cross rate usable', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 }), async (seed) => {
        const { provider } = build(seed);
        for (const table of await walk(provider, 40)) {
          expect(usdRatesSchema.safeParse(table).success).toBe(true);
          for (const pair of rateMatrix(table)) {
            expect(pair.rate).toMatch(/^[0-9]{1,13}\.[0-9]{12}$/);
            expect(pair.rate).not.toBe('0.000000000000');
            expect(() => convert(1_000_000n, pair.rate)).not.toThrow();
          }
        }
      }),
      { numRuns: 25 },
    );
  });
});
