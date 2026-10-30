import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock/clock';
import { usdRatesSchema, type FxProvider, type FxRates, type UsdRates } from './fx-provider';

export const STATIC_RATES_PATH = join(__dirname, '..', '..', 'config', 'static-rates.json');

const fileSchema = z.object({ rates: usdRatesSchema }).passthrough();

export function loadStaticRates(path: string, loadedAt: Date): FxRates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read static FX rates from ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  const result = fileSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid static FX rates in ${path}:\n${lines.join('\n')}`);
  }
  return { rates: result.data.rates, providerUpdatedAt: loadedAt };
}

/**
 * Reads illustrative rates from config/static-rates.json once, at construction. Its
 * `providerUpdatedAt` is the time the file was loaded (from the injected Clock).
 */
@Injectable()
export class StaticFxProvider implements FxProvider {
  readonly name = 'static' as const;
  private readonly loaded: FxRates;

  constructor(@Inject(CLOCK) clock: Clock) {
    this.loaded = loadStaticRates(STATIC_RATES_PATH, clock.now());
  }

  /** The rates from the file, as a validated table (the anchor of the simulated feed). */
  anchorRates(): UsdRates {
    return { ...usdRatesSchema.parse(this.loaded.rates) };
  }

  fetchUsdRates(): Promise<FxRates> {
    return Promise.resolve({ ...this.loaded, rates: { ...this.loaded.rates } });
  }
}
