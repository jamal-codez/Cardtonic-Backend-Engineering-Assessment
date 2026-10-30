import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  SCHEDULERS_ENABLED: booleanString.default(true),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  /** Per-transaction cap in whole units. */
  MAX_TX_AMOUNT: z.coerce.bigint().positive().default(1_000_000_000n),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(24),
  // 'simulated' is a local random-walk feed standing in for a live market (see docs/decisions.md).
  FX_PROVIDER: z.enum(['static', 'simulated']).default('simulated'),
  RECON_INTERVAL_MS: z.coerce.number().int().min(5000).max(86_400_000).default(300_000),
  // At least a minute: the overlap is what protects against transactions that commit late.
  RECON_OVERLAP_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  RECON_FREEZE_ON_DRIFT: booleanString.default(false),
  // 54 seconds (0.9 minutes). Above 2^31-1 ms Node would clamp setInterval to 1 ms.
  FX_REFRESH_INTERVAL_MS: z.coerce.number().int().min(5000).max(86_400_000).default(54_000),
  /** Simulated feed: a small step is at most this many percent per refresh... */
  FX_SIM_SMALL_STEP_PCT: z.coerce.number().positive().max(50).default(0.3),
  /** ...and one refresh in about seven is a medium step of at most this many percent. */
  FX_SIM_MEDIUM_STEP_PCT: z.coerce.number().positive().max(50).default(1.5),
  /** The simulated rates stay within this many percent of the anchor (config/static-rates.json). */
  FX_SIM_BAND_PCT: z.coerce.number().positive().max(90).default(30),
  /** A snapshot where any rate moved more than this many percent is rejected. */
  FX_MAX_MOVE_PCT: z.coerce.number().positive().max(100).default(20),
});

export const configSchema = baseSchema.refine(
  (config) =>
    config.FX_SIM_SMALL_STEP_PCT <= config.FX_SIM_MEDIUM_STEP_PCT &&
    config.FX_SIM_MEDIUM_STEP_PCT <= config.FX_MAX_MOVE_PCT &&
    config.FX_SIM_MEDIUM_STEP_PCT <= config.FX_SIM_BAND_PCT,
  {
    path: ['FX_SIM_MEDIUM_STEP_PCT'],
    message:
      'must satisfy FX_SIM_SMALL_STEP_PCT <= FX_SIM_MEDIUM_STEP_PCT <= FX_MAX_MOVE_PCT and FX_SIM_MEDIUM_STEP_PCT <= FX_SIM_BAND_PCT, or the feed would be rejected by its own validation',
  },
);

export type AppConfig = z.infer<typeof configSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
